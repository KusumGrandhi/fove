/**
 * How much context a model actually has.
 *
 * The transcript records the model id but never the window it was served with,
 * so the denominator behind "60.8k of 1M" has to come from here. The table is
 * a bundled fact about Anthropic's models, which means it goes stale -- so the
 * unknown case is reported as unknown rather than silently assumed. A pane
 * pointed at OpenRouter or a model released after this file was written gets
 * `known: false`, and the UI says so instead of drawing a confident bar
 * against a number nobody checked.
 *
 * The `[1m]` suffix is checked first: it is how the CLI names a session opened
 * on the long-context variant of a model whose base id is 200k.
 */

export interface ContextWindow {
  /** Input tokens the model accepts in one request. */
  limit: number;
  /** False when the limit is a fallback rather than a looked-up fact. */
  known: boolean;
}

const MILLION = 1_000_000;
const DEFAULT_LIMIT = 200_000;

/**
 * Substring rules, most specific first. Substrings rather than exact ids
 * because transcripts carry dated snapshots (`claude-opus-4-5-20251101`),
 * provider prefixes (`anthropic.claude-opus-5`) and suffixes alike.
 */
const TABLE: Array<[match: string, limit: number]> = [
  ["fable-5", MILLION],
  ["mythos-5", MILLION],
  ["mythos-preview", MILLION],
  ["opus-5", MILLION],
  ["opus-4-8", MILLION],
  ["opus-4-7", MILLION],
  ["opus-4-6", MILLION],
  ["opus-4-5", DEFAULT_LIMIT],
  ["opus-4-1", DEFAULT_LIMIT],
  ["opus-4", DEFAULT_LIMIT],
  ["sonnet-5", MILLION],
  ["sonnet-4-6", MILLION],
  ["sonnet-4-5", DEFAULT_LIMIT],
  ["sonnet-4", DEFAULT_LIMIT],
  ["haiku-4-5", DEFAULT_LIMIT],
  ["haiku", DEFAULT_LIMIT],
];

export function contextWindowFor(model: string | undefined): ContextWindow {
  if (!model) return { limit: DEFAULT_LIMIT, known: false };
  const id = model.toLowerCase();
  // The long-context variant overrides whatever the base id would say.
  if (id.includes("[1m]") || id.endsWith("-1m")) return { limit: MILLION, known: true };
  for (const [match, limit] of TABLE) {
    if (id.includes(match)) return { limit, known: true };
  }
  return { limit: DEFAULT_LIMIT, known: false };
}
