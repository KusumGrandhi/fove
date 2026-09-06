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
import { replaySession } from "../data/replay.js";
import { listSessions, slugForCwd } from "../data/transcript.js";
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
  firstPrompt?: string;
  parsed: number;
  elapsedMs: number;
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
   * Read and summarise a session. Re-reads only when the file has changed,
   * because replaying an 11MB transcript on every poll would be wasteful.
   */
  async snapshot(cwd: string): Promise<SessionSnapshot | null> {
    const summary = await this.newestFor(cwd);
    if (!summary) return null;

    const cached = this.cache.get(summary.path);
    if (cached && cached.mtimeMs === summary.mtimeMs) return cached.snap;

    const r = await replaySession(summary);
    const u = r.usage.current;
    const agents = r.tree.ordered().filter((n) => n.id !== "root");
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
