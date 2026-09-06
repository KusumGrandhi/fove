/**
 * Codebase search, over ripgrep.
 *
 * `rg --json` emits one JSON object per event with line numbers and match
 * offsets already computed, so there is no output parsing to get wrong — the
 * kind of thing that otherwise breaks on a filename with a colon in it.
 *
 * Results stream back as they are found rather than arriving in one lump at
 * the end: a search across a large repository should show its first hits
 * immediately, and a slow search should be interruptible.
 *
 * Only one search runs at a time per requester. Typing in a search box fires a
 * query per keystroke, and without cancelling the previous one the results
 * would interleave and the last to *finish* would win rather than the last to
 * be *asked*.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Never return an unbounded result set: the UI cannot use 200k rows. */
const MAX_MATCHES = 2000;

export interface SearchMatch {
  path: string;
  line: number;
  /** The matching line, trimmed of its trailing newline. */
  text: string;
  /** Byte offsets of the match within `text`, for highlighting. */
  start: number;
  end: number;
}

export interface SearchQuery {
  query: string;
  cwd: string;
  /** Treat the query as a regular expression rather than a literal. */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Only files matching these globs, e.g. ["*.ts", "!*.test.ts"]. */
  globs?: string[];
  wholeWord?: boolean;
}

/** `rg --json` event shapes, narrowed to what is used here. */
interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string; bytes?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

/** A path is `text` for UTF-8, or base64 `bytes` when it is not. */
function pathOf(p?: { text?: string; bytes?: string }): string {
  if (p?.text) return p.text;
  if (p?.bytes) return Buffer.from(p.bytes, "base64").toString("utf8");
  return "";
}

export class SearchService {
  /** The in-flight search per requester id, so a new one supersedes it. */
  private readonly running = new Map<string, ChildProcess>();

  constructor(
    private readonly onMatch: (id: string, matches: SearchMatch[]) => void,
    private readonly onDone: (id: string, count: number, truncated: boolean) => void,
  ) {}

  /** Whether ripgrep is available at all, so the UI can say so plainly. */
  static async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("rg", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  cancel(id: string): void {
    const child = this.running.get(id);
    if (child) {
      child.kill();
      this.running.delete(id);
    }
  }

  cancelAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  /**
   * Start a search, replacing any previous one from the same requester.
   *
   * Matches are delivered in batches: one IPC message per match would flood
   * the channel on a broad query, and the renderer only repaints per frame
   * anyway.
   */
  start(id: string, q: SearchQuery): void {
    this.cancel(id);
    if (!q.query.trim()) {
      this.onDone(id, 0, false);
      return;
    }

    const args = ["--json", "--line-number", "--max-count", "200"];
    if (!q.regex) args.push("--fixed-strings");
    args.push(q.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (q.wholeWord) args.push("--word-regexp");
    for (const glob of q.globs ?? []) args.push("--glob", glob);
    // `--` so a query beginning with a dash is a pattern, not a flag.
    args.push("--", q.query, ".");

    const child = spawn("rg", args, { cwd: q.cwd });
    this.running.set(id, child);

    let count = 0;
    let truncated = false;
    let buffer = "";
    let batch: SearchMatch[] = [];

    const flush = (): void => {
      if (batch.length === 0) return;
      this.onMatch(id, batch);
      batch = [];
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // rg emits newline-delimited JSON; the last piece may be partial.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        let event: RgEvent;
        try {
          event = JSON.parse(line) as RgEvent;
        } catch {
          continue; // a malformed line costs that line only
        }
        if (event.type !== "match" || !event.data) continue;

        const text = (event.data.lines?.text ?? "").replace(/\n$/, "");
        const sub = event.data.submatches?.[0];
        batch.push({
          path: pathOf(event.data.path),
          line: event.data.line_number ?? 0,
          text: text.length > 400 ? text.slice(0, 400) + "…" : text,
          start: sub?.start ?? 0,
          end: sub?.end ?? 0,
        });

        if (++count >= MAX_MATCHES) {
          truncated = true;
          flush();
          this.cancel(id);
          this.onDone(id, count, true);
          return;
        }
      }
      if (batch.length >= 50) flush();
    });

    child.on("error", () => {
      // rg missing or unable to start: report an end rather than hanging.
      this.running.delete(id);
      this.onDone(id, count, false);
    });

    child.on("close", () => {
      // A cancelled search has already been superseded; stay quiet.
      if (this.running.get(id) !== child) return;
      this.running.delete(id);
      flush();
      this.onDone(id, count, truncated);
    });
  }
}
