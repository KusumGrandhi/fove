/**
 * Turn boundaries: where one exchange with the agent ends and the next begins.
 *
 * Keel reviews a *turn* -- one prompt, the work it produced, the files it
 * touched -- so everything downstream depends on cutting the transcript into
 * turns correctly. That is harder than it looks, and the reason this is a pure
 * module with its own tests rather than a few lines inside a service.
 *
 * The trap, measured on a real 3,252-record transcript: only **191** of those
 * "user" records are prompts a human typed. The other 3,034 are tool results,
 * which the transcript also records with `role: "user"` because that is how the
 * API models a tool result. Treating every user record as a turn start yields
 * three thousand empty turns.
 *
 * Four filters, each for an observed case rather than a hypothetical one:
 *
 *   - `isSidechain` marks subagent traffic. A subagent's prompt is not a turn.
 *   - `isMeta` marks injected context (27 of them in that transcript).
 *   - a content array containing a `tool_result` block is a tool result.
 *   - a few synthetic strings -- "[Request interrupted by user]" and friends --
 *     are written by the CLI, not typed. They look exactly like prompts.
 *
 * Tolerant throughout, like the transcript reader it feeds from: an
 * unrecognised record shape contributes nothing rather than throwing. The
 * format is undocumented and moves between CLI releases.
 */

/** The subset of a transcript record this module needs. */
export interface TurnRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean | null;
  isSidechain?: boolean | null;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: Record<string, unknown> | null;
  } | null;
}

export interface Turn {
  /** The uuid of the user record that opened the turn. */
  id: string;
  /** What the user actually asked, trimmed. Empty when it could not be read. */
  prompt: string;
  startedAt: number;
  /** Absent while the turn is still running. */
  endedAt?: number;
  /** Records belonging to this turn, in file order, excluding the prompt. */
  recordCount: number;
}

/**
 * Strings the CLI writes into a user record that no human typed.
 *
 * These are indistinguishable from a prompt by shape -- same role, same string
 * content -- so they have to be matched by value. Kept narrow deliberately: a
 * prompt that merely *contains* one of these is still a prompt, so the match is
 * on the whole trimmed string.
 */
const SYNTHETIC_PROMPTS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
  "API Error: Request was aborted.",
]);

/**
 * Prefixes of records the CLI writes that are not a turn.
 *
 * Found by running this module over a real 14,151-record transcript and asking
 * why it produced nine *unfinished* turns when at most one can be live. All
 * nine were `/compact` machinery: the command invocation, its stdout, and the
 * continuation preamble the CLI injects afterwards. Each looks exactly like a
 * typed prompt, and each would render in Keel as a turn that changed nothing.
 *
 * Matched by prefix rather than equality because the bodies vary -- a summary
 * runs to thousands of characters.
 */
const SYNTHETIC_PREFIXES = [
  // A slash command the CLI expanded, e.g. /compact or /clear.
  "<command-name>",
  // Its output, echoed back into the transcript.
  "<local-command-stdout>",
  // The preamble injected when a session resumes after compaction.
  "This session is being continued from a previous conversation",
  // Injected context, when it arrives without the isMeta flag set.
  "<system-reminder>",
];

/** The text of a user message, or null when the record is not a typed prompt. */
export function promptText(rec: TurnRecord): string | null {
  if (rec.type !== "user") return null;
  // Subagent traffic and injected context are not turns.
  if (rec.isSidechain === true || rec.isMeta === true) return null;

  const content = rec.message?.content;

  if (typeof content === "string") {
    const text = content.trim();
    if (!text || isSynthetic(text)) return null;
    return text;
  }

  if (Array.isArray(content)) {
    // A tool result is recorded with role "user". It is the single most common
    // record in a transcript and is never a turn start.
    const blocks = content as { type?: string; text?: string }[];
    if (blocks.some((b) => b?.type === "tool_result")) return null;

    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (!text || isSynthetic(text)) return null;
    return text;
  }

  return null;
}

/** Whether a would-be prompt was written by the CLI rather than typed. */
function isSynthetic(text: string): boolean {
  if (SYNTHETIC_PROMPTS.has(text)) return true;
  return SYNTHETIC_PREFIXES.some((p) => text.startsWith(p));
}

/** Milliseconds since epoch, or undefined for a missing or unparseable stamp. */
export function timeOf(rec: TurnRecord): number | undefined {
  if (!rec.timestamp) return undefined;
  const ms = Date.parse(rec.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Cut a transcript into turns, oldest first.
 *
 * A turn runs from a typed prompt to the record before the next one. The last
 * turn has no `endedAt` when nothing followed it, which is how a running turn
 * is distinguished from a finished one -- there is no explicit "turn over"
 * record to rely on, and inventing one from `stop_reason` would be wrong: a
 * turn contains many assistant messages, most ending in `tool_use`.
 */
export function splitTurns(records: TurnRecord[]): Turn[] {
  const turns: Turn[] = [];

  for (const rec of records) {
    const prompt = promptText(rec);

    if (prompt !== null) {
      const startedAt = timeOf(rec);
      // A prompt with no readable timestamp cannot anchor a boundary, and a
      // turn that cannot be placed in time cannot be matched to a diff.
      if (startedAt === undefined) continue;
      turns.push({
        id: rec.uuid ?? `t${turns.length}`,
        prompt,
        startedAt,
        recordCount: 0,
      });
      continue;
    }

    // Everything else belongs to the turn in progress. Records before the
    // first prompt (session metadata, a resumed summary) belong to no turn.
    const current = turns[turns.length - 1];
    if (!current) continue;
    current.recordCount++;
    // Monotonic: a record that arrives out of order -- and transcripts are
    // appended by more than one writer -- must not drag the end backwards.
    const t = timeOf(rec);
    if (t === undefined || t < current.startedAt) continue;
    if (current.endedAt === undefined || t > current.endedAt) current.endedAt = t;
  }

  return turns;
}

/** The most recent turn, or null for a transcript with none. */
export function latestTurn(turns: Turn[]): Turn | null {
  return turns.length ? turns[turns.length - 1]! : null;
}

/**
 * Whether a turn looks finished.
 *
 * Heuristic, and named as one. There is no end-of-turn record, so "nothing has
 * happened for a while" is the only available signal. Used to decide whether
 * Keel opens on a turn or waits, never to decide anything destructive.
 */
export function looksFinished(turn: Turn, now: number, quietMs = 8000): boolean {
  if (turn.endedAt === undefined) return false;
  return now - turn.endedAt > quietMs;
}
