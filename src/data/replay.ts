/**
 * Rebuilds a completed session from disk: the main transcript plus every
 * subagent log, joined through the .meta.json sidecars.
 *
 * This is the M1 path -- no SDK, no live query, just the ~223 transcripts
 * already on this machine. It shares its output model (AgentTree) with the live
 * path, so the same renderers serve both.
 */

import { AgentTree } from "./agentTree.js";
import { CategoryAccumulator, type ContextCategories } from "./contextCategories.js";
import {
  listSubagentLogs,
  loadSubagentMeta,
  readTranscript,
  type ParseStats,
} from "./transcript.js";
import { UsageAccumulator } from "./usage.js";
import type { SessionSummary, TranscriptRecord } from "./types.js";

/**
 * What the model was actually holding on the last turn.
 *
 * Distinct from the cumulative totals, and the more useful of the two for a
 * live readout: totals say what the session has cost, this says how full the
 * window is right now. It is the last main-loop request's prompt, which is
 * exactly what `/context` reports -- fresh input plus whatever was read from
 * or written to cache, since all three were part of the same prompt.
 */
export interface ContextSnapshot {
  /** Prompt tokens neither cached nor cacheable on that turn. */
  inputTokens: number;
  /** Prompt tokens served from an existing cache entry. */
  cacheReadTokens: number;
  /** Prompt tokens written into a new cache entry. */
  cacheCreationTokens: number;
  /** The three above -- everything the model was sent. */
  totalTokens: number;
  model?: string;
  /** When that turn happened, for staleness. */
  at?: number;
}

export interface ReplayResult {
  tree: AgentTree;
  usage: UsageAccumulator;
  stats: ParseStats;
  /** Wall-clock span of the session. */
  startedAt?: number;
  endedAt?: number;
  firstPrompt?: string;
  elapsedMs: number;
  /** Window occupancy on the last main-loop turn, absent before the first. */
  context?: ContextSnapshot;
  /** What is in that window, by category, measured from the attachments. */
  categories: ContextCategories;
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
  const categories = new CategoryAccumulator();

  // Sidecars first: they establish agentId -> tool_use id aliases and real
  // agent names, so records arriving under either id land on one node.
  const metas = await loadSubagentMeta(session);
  tree.registerMeta(metas.values());

  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let firstPrompt: string | undefined;
  let context: ContextSnapshot | undefined;

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
    // Attachments only, and only from the main transcript: a subagent's
    // prompt is assembled separately and does not add to this window.
    categories.add(rec);
    if (rec.type === "user" && !rec.isSidechain && firstPrompt === undefined) {
      const t = textOf(rec);
      // Skip tool_result-only user records and harness noise.
      if (t && !t.startsWith("<")) firstPrompt = t.slice(0, 200);
    }
    if (rec.type === "assistant") {
      usage.addStep(rec.message?.id, rec.message?.usage);
      /*
       * Window occupancy, from the main loop only.
       *
       * A sidechain record is a subagent's own request: it has its own window,
       * and counting it here would make the rail report a subagent's context as
       * the pane's. Records arrive in file order, so the last one to pass this
       * test is the newest turn.
       */
      if (!rec.isSidechain) {
        const u = rec.message?.usage;
        const total =
          (u?.input_tokens ?? 0) +
          (u?.cache_read_input_tokens ?? 0) +
          (u?.cache_creation_input_tokens ?? 0);
        // A zero total means this record carried no prompt figures at all --
        // keep the previous turn rather than blanking the readout.
        if (u && total > 0) {
          context = {
            inputTokens: u.input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            totalTokens: total,
            model: rec.message?.model,
            at: rec.timestamp ? Date.parse(rec.timestamp) : undefined,
          };
        }
      }
    }
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
    context,
    categories: categories.current,
  };
}
