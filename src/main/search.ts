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
import { spawnEnv } from "./loginPath.js";

/** Never return an unbounded result set: the UI cannot use 200k rows. */
const MAX_MATCHES = 2000;

/**
 * Filename hits are a shortlist, not a listing.
 *
 * A one-letter query matches almost every path in a repository, and burying
 * the content results under thousands of them would be worse than not
 * searching paths at all.
 */
const PATH_MATCH_CAP = 50;

export interface SearchMatch {
  path: string;
  /** 0 for a filename match, which has no line to point at. */
  line: number;
  /** The matching line, trimmed of its trailing newline. */
  text: string;
  /** Byte offsets of the match within `text`, for highlighting. */
  start: number;
  end: number;
  /**
   * True when the query matched the *path* rather than the file's contents.
   *
   * Searching for `AGENTS.md` should find the file called that, not only the
   * places that mention it. Without this the pane answers a question the user
   * did not ask and reports "no matches" while the file sits in the tree.
   */
  isPath?: boolean;
  /** A path hit that matched as a substring, rather than a subsequence. */
  exact?: boolean;
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

/**
 * A path is `text` for UTF-8, or base64 `bytes` when it is not.
 *
 * The leading `./` is stripped. rg echoes back the search root it was given,
 * so a content hit arrives as `./readme.md` while `rg --files` reports
 * `readme.md` for the same file -- and without normalising, the two disagree:
 * results group under two headings and an opened path becomes `cwd/./file`.
 */
function pathOf(p?: { text?: string; bytes?: string }): string {
  const raw = p?.text ?? (p?.bytes ? Buffer.from(p.bytes, "base64").toString("utf8") : "");
  return raw.startsWith("./") ? raw.slice(2) : raw;
}

/**
 * How a query matches a file path.
 *
 * A plain substring test is not enough for the case this feature exists to
 * fix: typing `agent.md` should find `AGENTS.md`, and "agent.md" is not a
 * substring of it -- the `S` and the case both intervene. So a substring hit
 * is preferred, and a *subsequence* of the basename is accepted as a
 * fallback, which is how every editor's file-finder behaves.
 *
 * The subsequence is deliberately limited to the basename. Allowing it across
 * the whole path would let `a/b` match almost anything, since the letters are
 * scattered through every directory name.
 *
 * Returns the highlight range within the full path, or null for no match.
 */
function pathMatcher(
  needle: string,
  caseSensitive: boolean,
): (path: string) => { start: number; end: number; exact: boolean } | null {
  return (path: string) => {
    const hay = caseSensitive ? path : path.toLowerCase();

    const direct = hay.indexOf(needle);
    if (direct >= 0) return { start: direct, end: direct + needle.length, exact: true };

    // Fall back to a subsequence over the basename only.
    const slash = hay.lastIndexOf("/");
    const base = hay.slice(slash + 1);
    let i = 0;
    let first = -1;
    let last = -1;
    for (let j = 0; j < base.length && i < needle.length; j++) {
      if (base[j] !== needle[i]) continue;
      if (first < 0) first = j;
      last = j;
      i++;
    }
    if (i < needle.length) return null;
    return { start: slash + 1 + first, end: slash + 1 + last + 1, exact: false };
  };
}

/**
 * The environment `rg` is spawned with, resolved once.
 *
 * A Finder-launched Electron app inherits a minimal PATH -- `/usr/bin:/bin`
 * and little else -- which does not contain Homebrew's `rg`. Without this the
 * spawn fails with ENOENT, the error path reports zero matches, and search
 * answers "no matches" for a word that is in fifty files. It works when the
 * app is started from a terminal, which is exactly what makes the bug easy to
 * ship: `npm run dev` inherits a real PATH and the installed app does not.
 *
 * Resolved once and reused: `loginPath()` spawns a login shell, which is far
 * too slow to do on every keystroke of a debounced search. The promise is
 * cached rather than the value so concurrent searches share one resolution.
 */
let envOnce: Promise<NodeJS.ProcessEnv> | undefined;
function rgEnv(): Promise<NodeJS.ProcessEnv> {
  envOnce ??= spawnEnv();
  return envOnce;
}

export class SearchService {
  /** The in-flight search per requester id, so a new one supersedes it. */
  private readonly running = new Map<string, ChildProcess>();

  /**
   * Bumped on every `start`, to discard a search that was superseded while
   * its environment was still being resolved.
   */
  private generation = 0;

  constructor(
    private readonly onMatch: (id: string, matches: SearchMatch[]) => void,
    private readonly onDone: (id: string, count: number, truncated: boolean) => void,
    /** Why a search could not run at all, when that is the reason for no results. */
    private readonly onFailed?: (id: string, reason: string) => void,
  ) {}

  /** Whether ripgrep is available at all, so the UI can say so plainly. */
  static async available(): Promise<boolean> {
    const env = await rgEnv();
    return new Promise((resolve) => {
      const child = spawn("rg", ["--version"], { stdio: "ignore", env });
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
    /*
     * The env is resolved before either pass starts, so both spawn with the
     * same PATH and neither method has to be async.
     *
     * A search superseded while the env was still resolving must not start:
     * `cancel` ran before this promise settled, so there is nothing in
     * `running` to kill, and the pass would otherwise spawn an orphan that
     * outlives the query that asked for it.
     */
    const generation = ++this.generation;
    void rgEnv().then((env) => {
      if (generation !== this.generation) return;
      // Filenames first: they are usually what a bare word like "AGENTS.md"
      // means, and they finish fast enough to appear before the content hits.
      this.searchPaths(id, q, env, (pathCount) =>
        this.searchContents(id, q, env, pathCount));
    });
  }

  /**
   * Match the query against file *paths*, via `rg --files`.
   *
   * Separate from the content search rather than folded into it: `rg` has no
   * single invocation that reports both, and a path hit has no line number,
   * so it is a different kind of result rather than a variation on one.
   */
  private searchPaths(
    id: string,
    q: SearchQuery,
    env: NodeJS.ProcessEnv,
    done: (count: number) => void,
  ): void {
    const args = ["--files"];
    for (const glob of q.globs ?? []) args.push("--glob", glob);

    const child = spawn("rg", args, { cwd: q.cwd, env });
    this.running.set(id, child);

    const needle = q.caseSensitive ? q.query : q.query.toLowerCase();
    const match = pathMatcher(needle, q.caseSensitive === true);
    let buffer = "";
    let found = 0;
    let batch: SearchMatch[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const path of lines) {
        if (!path || found >= PATH_MATCH_CAP) continue;
        const hit = match(path);
        if (!hit) continue;
        found++;
        batch.push({
          path, line: 0, text: path, start: hit.start, end: hit.end,
          isPath: true, exact: hit.exact,
        });
      }
      // Held until the end rather than streamed: ordering exact hits above
      // fuzzy ones needs the whole set, and `rg --files` finishes fast enough
      // that nothing is gained by emitting them piecemeal.
    });

    // `error` and `close` can both fire for one failed spawn, and running the
    // content pass twice would double every content match.
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (this.running.get(id) !== child) return; // superseded
      // Whatever is left in `buffer` is the last path, unterminated by a
      // newline. Dropping it would silently lose one result.
      const tail = buffer.trim();
      if (tail && found < PATH_MATCH_CAP) {
        const hit = match(tail);
        if (hit) {
          found++;
          batch.push({
            path: tail, line: 0, text: tail,
            start: hit.start, end: hit.end, isPath: true,
          });
        }
      }
      if (batch.length > 0) {
        // An exact substring hit is what the user typed; a subsequence hit is
        // a guess. Showing the guess first would bury the obvious answer.
        batch.sort((a, b) => Number(b.exact ?? false) - Number(a.exact ?? false));
        this.onMatch(id, batch);
        batch = [];
      }
      this.running.delete(id);
      done(found);
    };
    // A missing `rg` is reported once, by the content pass.
    child.on("error", finish);
    child.on("close", finish);
  }

  /** Match the query against file contents. */
  private searchContents(
    id: string,
    q: SearchQuery,
    env: NodeJS.ProcessEnv,
    priorCount: number,
  ): void {
    const args = ["--json", "--line-number", "--max-count", "200"];
    if (!q.regex) args.push("--fixed-strings");
    args.push(q.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (q.wholeWord) args.push("--word-regexp");
    for (const glob of q.globs ?? []) args.push("--glob", glob);
    // `--` so a query beginning with a dash is a pattern, not a flag.
    args.push("--", q.query, ".");

    const child = spawn("rg", args, { cwd: q.cwd, env });
    this.running.set(id, child);

    let count = priorCount;
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

    child.on("error", (err) => {
      /*
       * rg could not be started. Say so, rather than reporting zero matches.
       *
       * "no matches" for a word that is in fifty files is a confident wrong
       * answer, and it sent this bug undiagnosed through a release: the
       * failure looked exactly like an empty result. ENOENT here almost
       * always means `rg` is not on the PATH the app inherited.
       */
      this.running.delete(id);
      const why = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "ripgrep (rg) was not found on PATH"
        : `ripgrep could not start: ${err.message}`;
      this.onFailed?.(id, why);
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
