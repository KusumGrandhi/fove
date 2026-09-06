/**
 * Rebuilds a completed session from disk: the main transcript plus every
 * subagent log, joined through the .meta.json sidecars.
 *
 * This is the M1 path -- no SDK, no live query, just the ~223 transcripts
 * already on this machine. It shares its output model (AgentTree) with the live
 * path, so the same renderers serve both.
 */

import { AgentTree } from "./agentTree.js";
import {
  listSubagentLogs,
  loadSubagentMeta,
  readTranscript,
  type ParseStats,
} from "./transcript.js";
import { UsageAccumulator } from "./usage.js";
import type { SessionSummary, TranscriptRecord } from "./types.js";

export interface ReplayResult {
  tree: AgentTree;
  usage: UsageAccumulator;
  stats: ParseStats;
  /** Wall-clock span of the session. */
  startedAt?: number;
  endedAt?: number;
  firstPrompt?: string;
  elapsedMs: number;
}

function textOf(rec: TranscriptRecord): string | undefined {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return undefined;
  for (const b of c) {
    if (b.type === "text") {
      const t = (b as { text?: string }).text?.trim();
      if (t) return t;
    }
  }
  return undefined;
}

export async function replaySession(session: SessionSummary): Promise<ReplayResult> {
  const t0 = Date.now();
  const stats: ParseStats = { total: 0, parsed: 0, skipped: 0 };
  const tree = new AgentTree();
  const usage = new UsageAccumulator();

  // Sidecars first: they establish agentId -> tool_use id aliases and real
  // agent names, so records arriving under either id land on one node.
  const metas = await loadSubagentMeta(session);
  tree.registerMeta(metas.values());

  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let firstPrompt: string | undefined;

  const note = (rec: TranscriptRecord) => {
    if (!rec.timestamp) return;
    const t = Date.parse(rec.timestamp);
    if (Number.isNaN(t)) return;
    if (startedAt === undefined || t < startedAt) startedAt = t;
    if (endedAt === undefined || t > endedAt) endedAt = t;
  };

  for await (const rec of readTranscript(session.path, stats)) {
    note(rec);
    tree.addRecord(rec);
    if (rec.type === "user" && !rec.isSidechain && firstPrompt === undefined) {
      const t = textOf(rec);
      // Skip tool_result-only user records and harness noise.
      if (t && !t.startsWith("<")) firstPrompt = t.slice(0, 200);
    }
    if (rec.type === "assistant") usage.addStep(rec.message?.id, rec.message?.usage);
  }

  for (const log of await listSubagentLogs(session)) {
    for await (const rec of readTranscript(log, stats)) {
      note(rec);
      tree.addRecord(rec);
      if (rec.type === "assistant") usage.addStep(rec.message?.id, rec.message?.usage);
    }
  }

  tree.finalize();
  // A CLI transcript has no result record, so output tokens only exist as the
  // per-step figures gathered above.
  usage.settle();
  return {
    tree,
    usage,
    stats,
    startedAt,
    endedAt,
    firstPrompt,
    elapsedMs: Date.now() - t0,
  };
}
