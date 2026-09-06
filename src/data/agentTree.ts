/**
 * Reconstructs the subagent execution tree.
 *
 * Two sources, one model:
 *   - LIVE: SDK stream messages carry `parent_tool_use_id` -- the id of the
 *     Agent tool_use that spawned them -- at every nesting depth.
 *   - HISTORICAL: on-disk subagent logs carry `agentId` and
 *     `sourceToolAssistantUUID`, plus a uuid/parentUuid DAG.
 *
 * Both funnel through addRecord()/addStreamMessage() into the same
 * Map<toolUseId, AgentNode>, so the live and replay views share one renderer.
 *
 * Memory: transcripts on this machine reach 11MB for a single session, so each
 * node's transcript[] is a bounded ring buffer. We keep the most recent
 * entries; older ones are dropped (a spill-to-disk path can be added later
 * without changing this interface).
 */

import type {
  AgentNode,
  ContentBlock,
  TranscriptEntry,
  TranscriptRecord,
  Usage,
} from "./types.js";

export const ROOT_ID = "root";
const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_PREVIEW_CHARS = 2000;

/** Tools whose input names a file this agent touched. */
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addUsage(into: Usage, from: Usage | undefined): void {
  if (!from) return;
  into.input_tokens = (into.input_tokens ?? 0) + (from.input_tokens ?? 0);
  into.output_tokens = (into.output_tokens ?? 0) + (from.output_tokens ?? 0);
  into.cache_creation_input_tokens =
    (into.cache_creation_input_tokens ?? 0) + (from.cache_creation_input_tokens ?? 0);
  into.cache_read_input_tokens =
    (into.cache_read_input_tokens ?? 0) + (from.cache_read_input_tokens ?? 0);
}

function ts(rec: TranscriptRecord): number | undefined {
  if (!rec.timestamp) return undefined;
  const n = Date.parse(rec.timestamp);
  return Number.isNaN(n) ? undefined : n;
}

function truncate(s: string, max = MAX_PREVIEW_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function blocksOf(rec: TranscriptRecord): ContentBlock[] {
  const c = rec.message?.content;
  return Array.isArray(c) ? c : [];
}

export class AgentTree {
  readonly nodes = new Map<string, AgentNode>();
  /** Message ids already counted, so parallel tool calls aren't double-counted. */
  private readonly seenMessageIds = new Set<string>();
  /** uuid -> owning agent id, for attributing records that lack a direct marker. */
  private readonly uuidOwner = new Map<string, string>();
  /**
   * agentId -> canonical node id (the spawning tool_use id).
   *
   * Subagent logs are keyed by `agentId`; the main transcript keys the same
   * agent by its `toolu_...` tool_use id. The .meta.json sidecars supply the
   * mapping, without which each agent would appear as two disjoint nodes.
   */
  private readonly agentAlias = new Map<string, string>();

  constructor() {
    this.nodes.set(ROOT_ID, {
      id: ROOT_ID,
      parentId: null,
      name: "main",
      status: "running",
      usage: emptyUsage(),
      toolCalls: [],
      transcript: [],
      filesTouched: new Set(),
      depth: 0,
    });
  }

  get root(): AgentNode {
    return this.nodes.get(ROOT_ID)!;
  }

  /**
   * Register subagent metadata sidecars before replaying records.
   *
   * Establishes the agentId -> toolUseId aliases and seeds real agent names, so
   * records arriving under either id land on one node.
   */
  registerMeta(metas: Iterable<{
    agentId: string;
    agentType?: string;
    description?: string;
    toolUseId?: string;
    spawnDepth?: number;
  }>): void {
    for (const m of metas) {
      const canonical = m.toolUseId || m.agentId;
      this.agentAlias.set(m.agentId, canonical);
      const node = this.ensure(canonical, ROOT_ID, m.agentType || m.description || m.agentId);
      if (m.agentType) node.name = m.agentType;
      if (m.description) node.label = m.description;
      if (typeof m.spawnDepth === "number") node.depth = m.spawnDepth;
    }
  }

  /** Resolve any id (agentId or tool_use id) to its canonical node id. */
  private canonical(id: string): string {
    return this.agentAlias.get(id) ?? id;
  }

  /** Nodes in stable depth-first order, for rendering. */
  ordered(): AgentNode[] {
    const byParent = new Map<string | null, AgentNode[]>();
    for (const n of this.nodes.values()) {
      const list = byParent.get(n.parentId) ?? [];
      list.push(n);
      byParent.set(n.parentId, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    }
    const out: AgentNode[] = [];
    const walk = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;
      out.push(node);
      for (const child of byParent.get(id) ?? []) walk(child.id);
    };
    walk(ROOT_ID);
    return out;
  }

  /** Agents currently running, for the tiled AgentGrid view. */
  running(): AgentNode[] {
    return this.ordered().filter((n) => n.id !== ROOT_ID && n.status === "running");
  }

  private ensure(id: string, parentId: string | null, name: string): AgentNode {
    let node = this.nodes.get(id);
    if (node) return node;
    const parent = parentId ? this.nodes.get(parentId) : undefined;
    node = {
      id,
      parentId: parentId ?? ROOT_ID,
      name,
      status: "queued",
      usage: emptyUsage(),
      toolCalls: [],
      transcript: [],
      filesTouched: new Set(),
      depth: (parent?.depth ?? 0) + 1,
    };
    this.nodes.set(id, node);
    return node;
  }

  private push(node: AgentNode, entry: TranscriptEntry): void {
    node.transcript.push(entry);
    if (node.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      node.transcript.splice(0, node.transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  /**
   * Which agent does this record belong to?
   *
   * Preference order: the explicit stream marker, then the on-disk agentId,
   * then the spawning tool_use uuid, then the parent DAG pointer. Falls back to
   * root, which is correct for main-loop records.
   */
  private ownerOf(rec: TranscriptRecord): string {
    if (rec.parent_tool_use_id) return this.canonical(rec.parent_tool_use_id);
    if (rec.agentId) return this.canonical(rec.agentId);
    if (rec.sourceToolAssistantUUID) {
      const owner = this.uuidOwner.get(rec.sourceToolAssistantUUID);
      if (owner) return owner;
    }
    if (rec.parentUuid) {
      const owner = this.uuidOwner.get(rec.parentUuid);
      if (owner) return owner;
    }
    return rec.isSidechain ? ROOT_ID : ROOT_ID;
  }

  /**
   * Feed one transcript record (historical replay or live).
   *
   * Unknown record types fall through harmlessly -- only user/assistant records
   * carry content we model.
   */
  addRecord(rec: TranscriptRecord): void {
    const type = rec.type;
    if (type !== "assistant" && type !== "user") return;

    const ownerId = this.ownerOf(rec);
    const node = this.nodes.get(ownerId) ?? this.ensure(ownerId, ROOT_ID, ownerId);
    const at = ts(rec);

    if (rec.uuid) this.uuidOwner.set(rec.uuid, ownerId);
    if (at !== undefined) {
      if (node.startedAt === undefined || at < node.startedAt) node.startedAt = at;
      if (node.endedAt === undefined || at > node.endedAt) node.endedAt = at;
    }
    if (node.status === "queued") node.status = "running";
    if (rec.message?.model) node.model = rec.message.model;

    // Per-step input/cache tokens are accurate once deduplicated by message id.
    // Output tokens here are a placeholder and are corrected from the result
    // message -- see usage.ts.
    const msgId = rec.message?.id;
    if (rec.message?.usage && (!msgId || !this.seenMessageIds.has(msgId))) {
      if (msgId) this.seenMessageIds.add(msgId);
      addUsage(node.usage, rec.message.usage);
    }

    for (const block of blocksOf(rec)) {
      switch (block.type) {
        case "text": {
          const text = (block as { text?: string }).text?.trim();
          if (text) this.push(node, { kind: "text", text: truncate(text), at });
          break;
        }
        case "thinking": {
          const text = (block as { thinking?: string }).thinking?.trim();
          if (text) this.push(node, { kind: "thinking", text: truncate(text), at });
          break;
        }
        case "tool_use": {
          const b = block as { id?: string; name?: string; input?: unknown };
          if (!b.id) break;
          const name = b.name ?? "tool";
          node.toolCalls.push({ id: b.id, name, input: b.input, startedAt: at });
          this.push(node, { kind: "tool_use", text: name, at });

          if (FILE_TOOLS.has(name)) {
            const fp = (b.input as { file_path?: string } | undefined)?.file_path;
            if (fp) node.filesTouched.add(fp);
          }
          // An Agent tool_use spawns a child; its id is the child's key.
          if (name === "Agent" || name === "Task") {
            const input = b.input as
              | { subagent_type?: string; description?: string; name?: string; model?: string }
              | undefined;
            const child = this.ensure(
              b.id,
              node.id,
              input?.subagent_type || input?.name || input?.description || "agent",
            );
            child.parentId = node.id;
            child.depth = node.depth + 1;
            if (input?.description) child.label ??= input.description;
            if (input?.model) child.model ??= input.model;
            child.startedAt ??= at;
          }
          break;
        }
        case "tool_result": {
          const b = block as { tool_use_id?: string; is_error?: boolean; content?: unknown };
          const call = node.toolCalls.find((c) => c.id === b.tool_use_id);
          if (call) {
            call.endedAt = at;
            call.isError = b.is_error === true;
          }
          // A tool_result for an Agent call closes that child agent.
          if (b.tool_use_id) {
            const child = this.nodes.get(b.tool_use_id);
            if (child) {
              child.status = b.is_error === true ? "error" : "done";
              child.endedAt = at ?? child.endedAt;
            }
          }
          break;
        }
      }
    }
  }

  /** Mark every still-running agent as finished. Call at end of replay. */
  finalize(): void {
    for (const node of this.nodes.values()) {
      if (node.status === "running" || node.status === "queued") node.status = "done";
    }
  }

  /** Nodes whose parent is missing -- should always be empty; asserted in tests. */
  orphans(): AgentNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.parentId !== null && !this.nodes.has(n.parentId),
    );
  }

  /** file -> agents that wrote it, for AgentDiff collision flagging. */
  fileCollisions(): Map<string, string[]> {
    const byFile = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      for (const f of node.filesTouched) {
        const list = byFile.get(f) ?? [];
        list.push(node.id);
        byFile.set(f, list);
      }
    }
    for (const [f, ids] of byFile) if (ids.length < 2) byFile.delete(f);
    return byFile;
  }
}
