/**
 * Claude session service: connects a pane running `claude` to its transcript.
 *
 * The CLI writes every session to ~/.claude/projects/<slug>/<id>.jsonl, so the
 * app can read what an agent is doing without instrumenting anything. This is
 * what makes the AI layer possible: no hooks, no wrappers, no cooperation
 * needed from the CLI.
 *
 * Discovery is by recency within the project directory: when a pane spawns
 * `claude` in a cwd, the newest transcript under that cwd's slug is that
 * session. It is a heuristic, and deliberately re-checked rather than cached
 * forever, because a session id only appears after the first turn.
 */

import { AgentTree } from "../data/agentTree.js";
import { replaySession, type ContextSnapshot } from "../data/replay.js";
import { contextWindowFor } from "../data/models/contextWindow.js";
import { estTokens } from "../data/config/skills.js";
import type { ContextCategories } from "../data/contextCategories.js";
import { listSessions, slugForCwd } from "../data/transcript.js";
import { sessionForPid } from "./sessionLink.js";
import type { AgentNode, SessionSummary } from "../data/types.js";

export interface SessionSnapshot {
  sessionId: string;
  path: string;
  mtimeMs: number;
  /** Agents excluding the root, newest-first ordering preserved from the tree. */
  agents: AgentNode[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUSD: number;
    wholeTree: boolean;
  };
  models: string[];
  /**
   * How full the window is, as of the last turn. Absent before the first
   * assistant reply -- a session that has been started but not yet used has
   * totals of zero and no context to report, which is different from "0%".
   */
  context?: ContextSnapshot & {
    /** Window the model was served with. */
    limit: number;
    /** False when the limit is a fallback, not a looked-up fact. */
    limitKnown: boolean;
  };
  /** What is in the window, by category, largest first. */
  categories: CategoryRow[];
  firstPrompt?: string;
  parsed: number;
  elapsedMs: number;
}

/** One row of the context breakdown, costed and ready to render. */
export interface CategoryRow {
  key: string;
  label: string;
  tokens: number;
  count: number;
  /** What was counted, in the words the rail shows on hover. */
  detail: string;
}

/**
 * Cost the measured categories.
 *
 * Rows that measured nothing are dropped rather than shown as zeros: an empty
 * row says "this costs nothing", when what happened is that the session never
 * used the feature. Sorted by size because the only question anyone opens this
 * to answer is "what is taking up the room".
 */
export function costCategories(c: ContextCategories): CategoryRow[] {
  const rows: CategoryRow[] = [
    /*
     * Deferred tools cost their name, not their schema.
     *
     * Both of these count the one-line entry a tool gets while it is merely
     * *offered*: 398 MCP tools came to 4k tokens on a real session, about ten
     * tokens each. The full description and input schema arrive only when
     * something actually reaches for the tool, and land in `toolSchemas`. Say
     * "names" in the label, or this reads as a wildly low tool cost next to
     * the CLI's own figure, which counts loaded schemas too.
     */
    { key: "builtinTools", label: "Tool names", ...c.builtinTools,
      detail: "one line per CLI tool on offer -- its schema loads on first use" },
    { key: "mcpTools", label: "MCP tool names", ...c.mcpTools,
      detail: "one line per tool an MCP server offers -- schemas load on first use" },
    { key: "toolSchemas", label: "Tool schemas", ...c.toolSchemas,
      detail: "full schemas for the tools this session actually reached for" },
    { key: "mcpInstructions", label: "MCP notes", ...c.mcpInstructions,
      detail: "usage notes the MCP servers ask to be shown" },
    { key: "agents", label: "Custom agents", ...c.agents,
      detail: "names and descriptions -- an agent's body loads when it runs" },
    { key: "memory", label: "Memory files", ...c.memory,
      detail: "CLAUDE.md and the memory index, as injected" },
    { key: "skills", label: "Skills", ...c.skills,
      detail: "the catalogue -- a skill's body loads when it is invoked" },
  ].map(({ bytes, ...row }) => ({ ...row, tokens: estTokens(bytes) }));

  return rows.filter((r) => r.tokens > 0 || r.count > 0).sort((a, b) => b.tokens - a.tokens);
}

export class ClaudeSessionService {
  /** Cache keyed by transcript path, invalidated on mtime change. */
  private readonly cache = new Map<string, { mtimeMs: number; snap: SessionSnapshot }>();

  /** The most recently touched transcript for a working directory. */
  async newestFor(cwd: string): Promise<SessionSummary | null> {
    const sessions = await listSessions({ slug: slugForCwd(cwd) });
    return sessions[0] ?? null;
  }

  /**
   * The transcript belonging to the Claude session running under `shellPid`.
   *
   * Preferred over `newestFor` whenever a pane is available: with more than one
   * session open on the same directory -- a fove pane and an editor, say --
   * "newest" is whichever was typed in last, so the rail showed numbers from a
   * session the user was not looking at.
   *
   * Returns null when that pane is not running Claude, which the caller should
   * report rather than paper over with another session's figures.
   */
  async forPane(cwd: string, shellPid: number): Promise<SessionSummary | null> {
    const sessionId = await sessionForPid(shellPid);
    if (!sessionId) return null;
    const sessions = await listSessions({ slug: slugForCwd(cwd) });
    return sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  /**
   * Read and summarise a session. Re-reads only when the file has changed,
   * because replaying an 11MB transcript on every poll would be wasteful.
   */
  async snapshot(cwd: string, shellPid?: number): Promise<SessionSnapshot | null> {
    // A pane's own session when we can identify it; otherwise the folder's
    // newest transcript, which is right when only one session is open.
    // When a pane was named, its own session is the only correct answer:
    // falling back to the newest transcript would report another session's
    // numbers under this pane's heading.
    const summary = shellPid
      ? await this.forPane(cwd, shellPid)
      : await this.newestFor(cwd);
    if (!summary) return null;

    const cached = this.cache.get(summary.path);
    if (cached && cached.mtimeMs === summary.mtimeMs) return cached.snap;

    const r = await replaySession(summary);
    const u = r.usage.current;
    const agents = r.tree.ordered().filter((n) => n.id !== "root");
    // The turn's own model is the one whose window applies. Falling back to a
    // subagent's model would be wrong -- a Haiku subagent does not shrink the
    // main loop's window.
    const window = contextWindowFor(r.context?.model);
    const snap: SessionSnapshot = {
      sessionId: summary.sessionId,
      path: summary.path,
      mtimeMs: summary.mtimeMs,
      agents,
      totals: {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        costUSD: u.costUSD,
        wholeTree: u.wholeTree,
      },
      models: [...new Set(agents.map((a) => a.model).filter(Boolean))] as string[],
      context: r.context
        ? { ...r.context, limit: window.limit, limitKnown: window.known }
        : undefined,
      categories: costCategories(r.categories),
      firstPrompt: r.firstPrompt,
      parsed: r.stats.parsed,
      elapsedMs: r.elapsedMs,
    };
    this.cache.set(summary.path, { mtimeMs: summary.mtimeMs, snap });
    return snap;
  }
}

/** Serialisable form of an agent, for the renderer. */
export interface AgentWire {
  id: string;
  parentId: string | null;
  name: string;
  label?: string;
  model?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  depth: number;
  tokens: number;
  toolCalls: number;
  files: string[];
  lastText?: string;
}

/** Sets and Maps do not survive IPC; flatten to plain data. */
export function toWire(agents: AgentNode[]): AgentWire[] {
  return agents.map((a) => ({
    id: a.id,
    parentId: a.parentId,
    name: a.name,
    label: a.label,
    model: a.model,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    depth: a.depth,
    tokens:
      (a.usage.input_tokens ?? 0) +
      (a.usage.output_tokens ?? 0) +
      (a.usage.cache_read_input_tokens ?? 0) +
      (a.usage.cache_creation_input_tokens ?? 0),
    toolCalls: a.toolCalls.length,
    files: [...a.filesTouched],
    lastText: a.transcript.filter((t) => t.kind === "text").at(-1)?.text?.slice(0, 200),
  }));
}
