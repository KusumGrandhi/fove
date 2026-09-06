/**
 * Token and cost accounting.
 *
 * The subagent trap, and why this file exists:
 *
 *   - A result message's `usage` counts ONLY the top-level agent loop. Every
 *     token consumed inside a subagent is missing from it. For an app whose
 *     centerpiece is subagent visualisation, accounting from `usage` would make
 *     every number on screen quietly wrong.
 *   - `modelUsage` (and `total_cost_usd`) DO include the whole tree, broken
 *     down per model. That is the only correct source for totals.
 *   - Per-step `output_tokens` on an assistant message is a placeholder: the
 *     count the API had reported at message_start, before the response was
 *     generated. Real output totals arrive on the result message, or per-delta
 *     via includePartialMessages.
 *   - Parallel tool calls emit several assistant messages sharing one message
 *     id with identical usage, so per-step input must be deduplicated by id.
 *
 * `total_cost_usd` is a client-side estimate from a bundled price table -- not
 * billing data, and meaningless on a subscription or a third-party endpoint.
 * See `costIsMeaningful`.
 */

import type { ModelUsage, Usage } from "./types.js";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  /** True once any figure came from modelUsage, i.e. includes subagents. */
  wholeTree: boolean;
  byModel: Map<string, ModelUsage>;
}

export function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    wholeTree: false,
    byModel: new Map(),
  };
}

/** Every token that was billed, however it was billed. */
export function totalTokens(u: Usage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

/** Share of input served from cache, or undefined when nothing was read. */
export function cacheHitRatio(u: Usage): number | undefined {
  const read = u.cache_read_input_tokens ?? 0;
  const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const denom = read + fresh;
  return denom === 0 ? undefined : read / denom;
}

export class UsageAccumulator {
  private readonly totals = emptyTotals();
  private readonly seenMessageIds = new Set<string>();
  /** Per-step output, kept apart from authoritative modelUsage figures. */
  private stepOutputTokens = 0;

  get current(): UsageTotals {
    return this.totals;
  }

  /**
   * Fold in a result message's per-model breakdown. This is the authoritative
   * path: it includes subagents. Call it for every result, success or error --
   * a failed turn still consumed tokens.
   */
  addResult(modelUsage: Record<string, ModelUsage> | undefined, totalCostUsd?: number): void {
    if (modelUsage) {
      for (const [model, mu] of Object.entries(modelUsage)) {
        const prev = this.totals.byModel.get(model);
        this.totals.byModel.set(model, {
          inputTokens: (prev?.inputTokens ?? 0) + (mu.inputTokens ?? 0),
          outputTokens: (prev?.outputTokens ?? 0) + (mu.outputTokens ?? 0),
          cacheReadInputTokens:
            (prev?.cacheReadInputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens:
            (prev?.cacheCreationInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0),
          costUSD: (prev?.costUSD ?? 0) + (mu.costUSD ?? 0),
          costBasis: mu.costBasis ?? prev?.costBasis,
        });
        this.totals.inputTokens += mu.inputTokens ?? 0;
        this.totals.outputTokens += mu.outputTokens ?? 0;
        this.totals.cacheReadTokens += mu.cacheReadInputTokens ?? 0;
        this.totals.cacheCreationTokens += mu.cacheCreationInputTokens ?? 0;
        if (mu.costUSD === undefined) continue;
        this.totals.costUSD += mu.costUSD;
      }
      this.totals.wholeTree = true;
    }
    // Prefer the reported call total when present; it models billing rules the
    // per-model sum does not (e.g. data-residency multipliers).
    if (typeof totalCostUsd === "number" && totalCostUsd > 0) {
      this.totals.costUSD = Math.max(this.totals.costUSD, totalCostUsd);
    }
  }

  /**
   * Fold in a per-step assistant message. Used for the live in-flight readout
   * before a result message lands, and for historical replay of transcripts
   * that have no result record.
   *
   * Output tokens are accumulated *separately* from `totals.outputTokens`.
   * They are a placeholder in the SDK -- the count at message_start, corrected
   * later by addResult() -- so they must never be added to an authoritative
   * modelUsage figure. But a CLI transcript contains no result record at all
   * (`modelUsage` appears zero times in ~/.claude/projects/**.jsonl), so
   * without this the output column reads 0 for every historical session.
   * `settle()` picks whichever source is real.
   *
   * The dedup matters for output specifically: parallel tool calls repeat the
   * same message id with identical usage, so the same output figure appears
   * several times and naive summing over-counts.
   */
  addStep(messageId: string | undefined, usage: Usage | undefined): void {
    if (!usage) return;
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return;
      this.seenMessageIds.add(messageId);
    }
    this.totals.inputTokens += usage.input_tokens ?? 0;
    this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.totals.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    this.stepOutputTokens += usage.output_tokens ?? 0;
  }

  /**
   * Resolve output tokens from the best source available.
   *
   * A result message (`modelUsage`) is authoritative and covers the whole
   * agent tree. Failing that -- every CLI transcript -- fall back to the
   * summed per-step counts, which are the only output figures those files
   * carry. Call once after replaying a session.
   */
  settle(): void {
    if (this.totals.outputTokens === 0 && this.stepOutputTokens > 0) {
      this.totals.outputTokens = this.stepOutputTokens;
    }
  }

  /** Live output count from a streaming message_delta event. */
  setStreamingOutput(outputTokens: number): void {
    this.totals.outputTokens = Math.max(this.totals.outputTokens, outputTokens);
  }
}

/**
 * Whether a dollar figure is worth showing.
 *
 * On a Max/Pro subscription the estimate does not correspond to anything the
 * user is billed, and on a third-party endpoint the bundled price table does
 * not apply at all. In both cases show tokens instead.
 */
export function costIsMeaningful(opts: {
  usingApiKey: boolean;
  thirdPartyProvider: boolean;
}): boolean {
  return opts.usingApiKey && !opts.thirdPartyProvider;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
