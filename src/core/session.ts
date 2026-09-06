/**
 * Live session: drives one Claude Code conversation through the Agent SDK.
 *
 * Streaming input mode -- the prompt is an AsyncIterable we push into -- so one
 * query() call carries the whole conversation and we keep the Query handle for
 * setModel/interrupt/supportedModels. A fresh query() per turn would discard
 * that handle and re-pay session startup each time.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentTree } from "../data/agentTree.ts";
import { UsageAccumulator } from "../data/usage.ts";

export type SessionPhase = "idle" | "starting" | "thinking" | "error" | "ended";

export interface PermissionRequest {
  toolName: string;
  input: unknown;
  resolve: (allow: boolean) => void;
}

export interface SessionCallbacks {
  onMessage?: (m: SDKMessage) => void;
  onPhase?: (p: SessionPhase) => void;
  onPermission?: (r: PermissionRequest) => void;
  onError?: (e: unknown) => void;
}

/** A queue that turns pushed prompts into the AsyncIterable query() consumes. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(text: string, sessionId: string): void {
    this.pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    } as SDKUserMessage);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
      this.wake = undefined;
    }
  }
}

export class LiveSession {
  readonly tree = new AgentTree();
  readonly usage = new UsageAccumulator();
  readonly messages: SDKMessage[] = [];

  phase: SessionPhase = "idle";
  sessionId?: string;
  model?: string;
  /** Where the API credential came from; decides whether cost is meaningful. */
  apiKeySource?: string;
  availableTools: string[] = [];

  private q?: Query;
  /** Resolves when system/init lands, i.e. after the first prompt. */
  readonly ready: Promise<void>;
  private markReady!: () => void;
  private readonly prompts = new PromptQueue();
  private readonly cb: SessionCallbacks;
  private readonly opts: {
    cwd: string;
    model?: string;
    resume?: string;
    /** Extra environment for the CLI subprocess, e.g. ANTHROPIC_BASE_URL. */
    env?: Record<string, string>;
  };

  constructor(
    opts: { cwd: string; model?: string; resume?: string; env?: Record<string, string> },
    cb: SessionCallbacks = {},
  ) {
    this.opts = opts;
    this.cb = cb;
    this.ready = new Promise<void>((r) => {
      this.markReady = r;
    });
  }

  private setPhase(p: SessionPhase): void {
    this.phase = p;
    this.cb.onPhase?.(p);
  }

  /**
   * Start the query and begin consuming its message stream.
   *
   * Note: in streaming-input mode the SDK emits nothing -- not even the
   * system/init message -- until the first prompt is queued. So sessionId,
   * model, apiKeySource and the tool list are unknown until the user's first
   * turn. The UI must render an "unknown" state rather than waiting on init.
   */
  start(): void {
    if (this.q) return;
    this.setPhase("starting");

    const options: Options = {
      cwd: this.opts.cwd,
      // Routing through the local proxy is just an env var on the subprocess.
      env: this.opts.env
        ? ({ ...process.env, ...this.opts.env } as Record<string, string>)
        : undefined,
      model: this.opts.model,
      resume: this.opts.resume,
      // Token-level streaming, and subagent text/thinking -- without the latter
      // subagents are opaque and the whole grid view is impossible.
      includePartialMessages: true,
      forwardSubagentText: true,
      permissionMode: "default",
      // Surface subprocess stderr; under a TUI it is otherwise swallowed.
      stderr: (data: string) => {
        if (process.env.TH_DEBUG) process.stderr.write(`[cc] ${data}`);
      },
      canUseTool: async (toolName, input) =>
        new Promise((resolve) => {
          if (!this.cb.onPermission) {
            resolve({ behavior: "allow", updatedInput: input as Record<string, unknown> });
            return;
          }
          this.cb.onPermission({
            toolName,
            input,
            resolve: (allow) =>
              resolve(
                allow
                  ? { behavior: "allow", updatedInput: input as Record<string, unknown> }
                  : { behavior: "deny", message: "Denied by user" },
              ),
          });
        }),
    };

    this.q = query({ prompt: this.prompts, options });
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const m of this.q!) {
        this.messages.push(m);
        this.route(m);
        this.cb.onMessage?.(m);
      }
      this.setPhase("ended");
    } catch (e) {
      this.setPhase("error");
      this.cb.onError?.(e);
    }
  }

  /** Fold one SDK message into the tree and usage accumulator. */
  private route(m: SDKMessage): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.sessionId = m.session_id;
          this.model = m.model;
          this.apiKeySource = m.apiKeySource;
          this.availableTools = m.tools ?? [];
          this.markReady();
          this.setPhase("idle");
        }
        break;

      case "assistant": {
        this.setPhase("thinking");
        // The tree consumes transcript-shaped records; SDK stream messages carry
        // the same fields under parent_tool_use_id.
        this.tree.addRecord({
          type: "assistant",
          uuid: m.uuid,
          parent_tool_use_id: m.parent_tool_use_id,
          timestamp: new Date().toISOString(),
          message: m.message as never,
        });
        this.usage.addStep(m.message?.id, m.message?.usage as never);
        break;
      }

      case "user":
        this.tree.addRecord({
          type: "user",
          uuid: m.uuid,
          parent_tool_use_id: m.parent_tool_use_id,
          timestamp: new Date().toISOString(),
          message: m.message as never,
        });
        break;

      case "stream_event": {
        // Live output-token count: the only trustworthy source before a result.
        const ev = m.event as { type?: string; usage?: { output_tokens?: number } };
        if (ev?.type === "message_delta" && typeof ev.usage?.output_tokens === "number") {
          this.usage.setStreamingOutput(ev.usage.output_tokens);
        }
        break;
      }

      case "result": {
        // modelUsage covers the whole tree; usage would omit every subagent.
        const r = m as unknown as {
          modelUsage?: Record<string, never>;
          total_cost_usd?: number;
        };
        this.usage.addResult(r.modelUsage, r.total_cost_usd);
        this.setPhase("idle");
        break;
      }
    }
  }

  send(text: string): void {
    this.prompts.push(text, this.sessionId ?? "pending");
    this.setPhase("thinking");
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => {});
    this.setPhase("idle");
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
    this.model = model;
  }

  /** Model picker options, straight from the CLI -- no hardcoded list to age. */
  async supportedModels(): Promise<ModelInfo[]> {
    try {
      return (await this.q?.supportedModels()) ?? [];
    } catch {
      return [];
    }
  }

  async stop(): Promise<void> {
    this.prompts.close();
    await this.q?.interrupt().catch(() => {});
    this.setPhase("ended");
  }
}
