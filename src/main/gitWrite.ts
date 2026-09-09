/**
 * Git write operations: staging, committing, stashing, remotes — plus the
 * history and blame reads that the graph and gutter need.
 *
 * Kept separate from `git.ts` because the risk profile is different. Reading a
 * repository is safe; `push --force`, `commit --amend` and `stash drop` can
 * destroy work, so every one of them reports git's own stderr verbatim rather
 * than a summarised message. A rejected push or a failing pre-commit hook is
 * exactly the text the user needs, and paraphrasing it is how a tool becomes
 * useless at the moment it matters most.
 *
 * As in `git.ts`, arguments are always passed as an array and never a shell
 * string, and `--` separates paths from revisions so a file named like a flag
 * cannot be misread.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Generous cap: a big repo's log can be megabytes, but not unbounded. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Separators.
 *
 * git strips a literal NUL or RS out of a `--format` string, so the *format*
 * must ask for them with git's own `%x..` escapes; the parser then splits on
 * the real bytes git emits. Passing the raw characters through silently
 * produced newline-joined output with every field run together.
 */
const FMT_NUL = "%x00";
const FMT_REC = "%x1e";
/**
 * `for-each-ref` speaks a different format language from `log`: it does not
 * understand `%x00`, and it strips a literal NUL. A ref name cannot contain a
 * space or a control character, so a printable token that is illegal in a ref
 * is the only separator that survives both facts.
 */
const REF_SEP = " |:| ";
const NUL = "\u0000";
const REC = "\u001e";

/**
 * The result of a mutating command.
 *
 * `stderr` is carried verbatim; see the file header for why.
 */
export interface GitWriteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  when: number;
  subject: string;
  refs: string[];
}

export interface BlameLine {
  hash: string;
  author: string;
  when: number;
  line: number;
  summary: string;
}

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
}

async function readGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true });
  return stdout;
}

/** Run a mutating git command, capturing stderr instead of throwing. */
async function gitWrite(cwd: string, args: string[]): Promise<GitWriteResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr || err.message || "git failed",
    };
  }
}

/** Feed `input` to a git command on stdin, so it never touches the command line. */
function gitStdin(cwd: string, args: string[], input: string): Promise<GitWriteResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout ?? "",
          // A failing hook writes to stdout as often as stderr, so fall back to
          // it rather than reporting an empty reason.
          stderr: stderr || (err ? stdout || String(err.message) : ""),
        });
      },
    );
    child.stdin?.end(input);
  });
}

export class GitWriteService {
  // ---- staging ------------------------------------------------------------

  /** Stage paths. */
  stage(cwd: string, paths: string[]): Promise<GitWriteResult> {
    if (paths.length === 0) return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    return gitWrite(cwd, ["add", "--", ...paths]);
  }

  /**
   * Unstage paths, leaving the working tree untouched.
   *
   * Before the first commit there is no HEAD to restore from -- `restore
   * --staged` fails with "could not resolve HEAD" -- so the very first staging
   * of a brand new repository is undone with `rm --cached` instead.
   */
  async unstage(cwd: string, paths: string[]): Promise<GitWriteResult> {
    if (paths.length === 0) return { ok: true, stdout: "", stderr: "" };
    const restored = await gitWrite(cwd, ["restore", "--staged", "--", ...paths]);
    if (restored.ok || !/could not resolve HEAD|unknown revision/i.test(restored.stderr)) {
      return restored;
    }
    return gitWrite(cwd, ["rm", "--cached", "-q", "--", ...paths]);
  }

  /**
   * Discard working-tree changes to paths. Destructive and unrecoverable —
   * the caller must confirm before calling.
   *
   * Tracked and untracked paths need different commands, and mixing them in
   * one `git restore` fails the *whole* call: restore errors with "pathspec
   * did not match any file(s) known to git" on the first untracked path and
   * restores none of the tracked ones. That is the worst outcome available --
   * the user is told nothing happened while believing the turn was reverted --
   * so they are separated here and both halves are reported.
   */
  async discard(cwd: string, paths: string[]): Promise<GitWriteResult> {
    if (paths.length === 0) return { ok: true, stdout: "", stderr: "" };

    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const p of paths) {
      // `ls-files --error-unmatch` is the cheap "does git know this path"
      // question; a non-zero exit means it does not.
      const known = await gitWrite(cwd, ["ls-files", "--error-unmatch", "--", p]);
      (known.ok ? tracked : untracked).push(p);
    }

    const parts: GitWriteResult[] = [];
    if (tracked.length > 0) {
      parts.push(await gitWrite(cwd, ["restore", "--worktree", "--", ...tracked]));
    }
    if (untracked.length > 0) {
      // A file the turn created is reverted by deleting it. `-q` keeps the
      // output quiet; `--` guards a path that begins with a dash.
      parts.push(await gitWrite(cwd, ["clean", "-fdq", "--", ...untracked]));
    }

    return {
      ok: parts.every((r) => r.ok),
      stdout: parts.map((r) => r.stdout).join(""),
      stderr: parts.map((r) => r.stderr).filter(Boolean).join("\n"),
    };
  }

  /**
   * Apply a patch to the index — the mechanism behind per-hunk staging.
   *
   * The patch goes in on stdin so no temporary file is written, and
   * `--unidiff-zero` is required because hunks generated with zero context
   * are otherwise rejected.
   */
  applyPatch(cwd: string, patch: string, reverse = false): Promise<GitWriteResult> {
    const args = ["apply", "--cached", "--unidiff-zero"];
    if (reverse) args.push("--reverse");
    // git rejects a patch that does not end in a newline as corrupt.
    return gitStdin(cwd, args, patch.endsWith("\n") ? patch : patch + "\n");
  }

  // ---- committing ---------------------------------------------------------

  /**
   * Commit the index.
   *
   * The message is passed on stdin (`-F -`), never on the command line, so
   * newlines, quotes and backticks survive exactly as written.
   */
  commit(
    cwd: string,
    message: string,
    opts: { amend?: boolean; noVerify?: boolean } = {},
  ): Promise<GitWriteResult> {
    const args = ["commit", "-F", "-"];
    if (opts.amend) args.push("--amend");
    if (opts.noVerify) args.push("--no-verify");
    return gitStdin(cwd, args, message);
  }

  // ---- remotes ------------------------------------------------------------

  /**
   * Push.
   *
   * `--force-with-lease` rather than `--force`: it refuses when the remote has
   * commits the local repository has not seen, which is the case where a plain
   * force would silently destroy someone else's work.
   */
  push(
    cwd: string,
    opts: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean } = {},
  ): Promise<GitWriteResult> {
    const args = ["push"];
    if (opts.setUpstream) args.push("--set-upstream");
    if (opts.force) args.push("--force-with-lease");
    if (opts.remote) args.push(opts.remote);
    if (opts.branch) args.push(opts.branch);
    return this.noPrompt(cwd, args);
  }

  pull(cwd: string, opts: { rebase?: boolean } = {}): Promise<GitWriteResult> {
    const args = ["pull"];
    if (opts.rebase) args.push("--rebase");
    return this.noPrompt(cwd, args);
  }

  fetch(cwd: string): Promise<GitWriteResult> {
    return this.noPrompt(cwd, ["fetch", "--all", "--prune"]);
  }

  /**
   * Run a network command that must never block.
   *
   * `GIT_TERMINAL_PROMPT=0` makes git fail with a readable error instead of
   * waiting forever on a credential prompt that has no terminal to appear in —
   * a hang here would look like the app freezing.
   */
  private async noPrompt(cwd: string, args: string[]): Promise<GitWriteResult> {
    try {
      const { stdout, stderr } = await run("git", args, {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr || err.message || "git failed",
      };
    }
  }

  // ---- stash --------------------------------------------------------------

  /**
   * Stash the working tree. Untracked files are included only when asked:
   * sweeping up files the user never told git about is a surprising default.
   */
  stashPush(cwd: string, message?: string, includeUntracked = false): Promise<GitWriteResult> {
    const args = ["stash", "push"];
    if (includeUntracked) args.push("--include-untracked");
    if (message) args.push("-m", message);
    return gitWrite(cwd, args);
  }

  /** Restore a stash and drop it. */
  stashPop(cwd: string, ref = "stash@{0}"): Promise<GitWriteResult> {
    return gitWrite(cwd, ["stash", "pop", ref]);
  }

  /** Restore a stash, keeping it in the list. */
  stashApply(cwd: string, ref = "stash@{0}"): Promise<GitWriteResult> {
    return gitWrite(cwd, ["stash", "apply", ref]);
  }

  /** Delete a stash. Unrecoverable — the caller must confirm first. */
  stashDrop(cwd: string, ref = "stash@{0}"): Promise<GitWriteResult> {
    return gitWrite(cwd, ["stash", "drop", ref]);
  }

  async stashList(cwd: string): Promise<StashEntry[]> {
    try {
      const out = await readGit(cwd, ["stash", "list", `--format=%gd${FMT_NUL}%s${FMT_REC}`]);
      return out
        .split(REC)
        .map((r) => r.replace(/^\n/, ""))
        .filter((r) => r.length > 0)
        .map((rec, i) => {
          const [ref, message] = rec.split(NUL);
          return { index: i, ref: ref ?? "", message: message ?? "" };
        });
    } catch {
      return [];
    }
  }

  // ---- history ------------------------------------------------------------

  /**
   * Commit history with parent links — enough to lay out a graph.
   *
   * Fields are NUL-separated and records end with a record separator, because
   * a commit subject can contain anything, newlines included. Letting git's
   * own `--graph` ASCII art through would mean parsing drawing characters back
   * into a DAG; the parent list is the real structure.
   *
   * Three choices here exist to make the drawn graph readable, and all three
   * were measured against a real repository with ~20 active branches:
   *
   *   - `--topo-order`, because git's default is strict reverse-chronological.
   *     When many branches are worked on the same day that interleaves them
   *     commit by commit, so consecutive rows belong to different branches and
   *     every lane zigzags. Measured on that repo: 58% of rows broke their
   *     lane by date, 26% by topology. Topological order keeps a branch's
   *     commits contiguous, which is what makes the lanes trace.
   *
   *   - `--branches --remotes --tags` rather than `--all`, because `--all`
   *     includes `refs/stash`, and each stash contributes up to three commits
   *     ("WIP on…", "index on…", "untracked files on…"). With 53 stashes that
   *     is noise at the top of the graph where the newest real work should be.
   *     `--exclude=refs/stash` does *not* remove them; dropping `--all` does.
   *
   *   - `HEAD` explicitly, because losing `--all` would otherwise lose a
   *     detached HEAD — the commit you are actually sitting on would vanish
   *     from the graph. Verified in a fixture; it matters here because
   *     worktrees can leave HEAD detached.
   *
   * `all: false` answers a different and more common question: "what is on the
   * branch I am on". It follows first parents from HEAD only, which is one
   * straight line — your commits, then the trunk history you branched from,
   * with nobody else's branches in it. On a repo where twenty branches are
   * active the same day, that is the difference between a readable graph and
   * a thicket; HEAD sits at row 43 of the full view here, which is no use.
   */
  async log(cwd: string, limit = 200, all = true): Promise<Commit[]> {
    const fmt = ["%H", "%P", "%an", "%ae", "%at", "%s", "%D"].join(FMT_NUL) + FMT_REC;
    const args = ["log", "--topo-order", `--max-count=${limit}`, `--format=${fmt}`];
    if (all) args.push("HEAD", "--branches", "--remotes", "--tags");
    // --first-parent so a merge brings in its own line rather than everything
    // the merged branch ever carried, which would put other people's commits
    // back into a view whose whole point is that it excludes them.
    else args.push("HEAD", "--first-parent");
    try {
      const out = await readGit(cwd, args);
      return out
        .split(REC)
        .map((r) => r.replace(/^\n/, ""))
        .filter((r) => r.trim().length > 0)
        .map((rec) => {
          const f = rec.split(NUL);
          return {
            hash: f[0] ?? "",
            parents: (f[1] ?? "").split(" ").filter(Boolean),
            author: f[2] ?? "",
            email: f[3] ?? "",
            when: Number(f[4] ?? 0) * 1000,
            subject: f[5] ?? "",
            refs: (f[6] ?? "").split(",").map((r) => r.trim()).filter(Boolean),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Per-line blame.
   *
   * `--porcelain` prints a commit's header only the first time that commit
   * appears, so author and time are cached by hash while walking the output;
   * later lines from the same commit carry the hash alone.
   */
  async blame(cwd: string, path: string): Promise<BlameLine[]> {
    try {
      const out = await readGit(cwd, ["blame", "--porcelain", "--", path]);
      const meta = new Map<string, { author: string; when: number; summary: string }>();
      const lines: BlameLine[] = [];
      let hash = "";
      let lineNo = 0;
      let cur: { author?: string; when?: number; summary?: string } = {};

      for (const raw of out.split("\n")) {
        const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
        if (header) {
          hash = header[1]!;
          lineNo = Number(header[2]);
          cur = {};
          continue;
        }
        if (raw.startsWith("author ")) cur.author = raw.slice(7);
        else if (raw.startsWith("author-time ")) cur.when = Number(raw.slice(12)) * 1000;
        else if (raw.startsWith("summary ")) cur.summary = raw.slice(8);
        else if (raw.startsWith("\t")) {
          // The tab-prefixed line is the source line itself: the record is done.
          const known = meta.get(hash);
          const author = cur.author ?? known?.author ?? "";
          const when = cur.when ?? known?.when ?? 0;
          const summary = cur.summary ?? known?.summary ?? "";
          if (!known) meta.set(hash, { author, when, summary });
          lines.push({ hash, author, when, line: lineNo, summary });
        }
      }
      return lines;
    } catch {
      return [];
    }
  }

  /** Branches, with the current one marked. */
  async branches(cwd: string): Promise<{ name: string; current: boolean; remote: boolean }[]> {
    try {
      const out = await readGit(cwd, [
        "for-each-ref",
        `--format=%(refname:short)${REF_SEP}%(HEAD)${REF_SEP}%(refname)`,
        "refs/heads",
        "refs/remotes",
      ]);
      return out
        .split("\n")
        .filter((r) => r.trim().length > 0)
        .map((rec) => {
          const [name, head, full] = rec.split(REF_SEP);
          return {
            name: (name ?? "").trim(),
            current: (head ?? "").trim() === "*",
            remote: (full ?? "").trim().startsWith("refs/remotes/"),
          };
        });
    } catch {
      return [];
    }
  }
}
