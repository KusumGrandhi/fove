/**
 * Git service.
 *
 * Read operations observe a repository; write operations (stage, commit,
 * stash, push) mutate it. Every write returns the command's real stderr on
 * failure rather than a generic message -- git's own errors are the useful
 * ones, and a hook that rejects a commit must be readable by the user.
 *
 * Commands run with `-z` / `--porcelain` wherever git offers it, and arguments
 * are passed as an array (never a shell string), so paths containing spaces,
 * quotes or newlines cannot be misparsed or injected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseStatus, parseWorktrees, parseDiff } from "../shared/git-parse.js";
import type { FileDiff, RepoStatus, Worktree } from "../shared/git-parse.js";

const run = promisify(execFile);

/** Generous cap: a big repo's diff can be megabytes, but not unbounded. */
const MAX_BUFFER = 32 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

export class GitService {
  /** Repository root, or null when the path is not in a git repo. */
  async root(cwd: string): Promise<string | null> {
    try {
      return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Repository status.
   *
   * `--untracked-files=all` is deliberate: git's default collapses a new
   * directory into a single entry ending in `/`, so adding a folder of twelve
   * files reads as "1 changed" and none of them can be staged individually.
   * The cost is that git walks every untracked file, which `.gitignore`
   * already bounds in practice.
   */
  async status(cwd: string): Promise<RepoStatus | null> {
    try {
      return parseStatus(
        await git(cwd, [
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=all",
        ]),
      );
    } catch {
      return null;
    }
  }

  async worktrees(cwd: string): Promise<Worktree[]> {
    try {
      const out = await git(cwd, ["worktree", "list", "--porcelain"]);
      const root = await this.root(cwd);
      return parseWorktrees(out, root ?? cwd);
    } catch {
      return [];
    }
  }

  /**
   * How many parents a commit has: 0 for a root, 1 normally, 2+ for a merge.
   *
   * This decides how the commit can be diffed at all, and the three cases need
   * three different commands -- see `diff`.
   */
  async parentCount(cwd: string, commit: string): Promise<number> {
    try {
      const out = await git(cwd, ["rev-list", "--parents", "-n1", commit]);
      // "<sha> <parent>..." -- the first word is the commit itself.
      return Math.max(0, out.trim().split(/\s+/).filter(Boolean).length - 1);
    } catch {
      return 1;
    }
  }

  /**
   * Diff for the working tree, the index, or a specific commit.
   *
   * `staged` selects the index; `commit` overrides both and shows that commit's
   * own change. Untracked files are included via --no-index against /dev/null
   * only when explicitly asked, since that costs an extra process per file.
   *
   * The commit case has three shapes, and the obvious single command is wrong
   * for two of them -- both by printing *nothing* rather than failing, which
   * would render as "this commit changed no files":
   *
   *   - a root commit has no parent, so `<sha>^!` resolves to an empty range
   *     and exits 0 with no output. It needs `show`, which diffs against the
   *     empty tree.
   *   - a merge prints nothing for both `<sha>^!` and a bare `show`, because
   *     git's default for a merge is a combined diff that is suppressed unless
   *     the merge resolved a conflict. It needs an explicit first-parent diff.
   *
   * All three verified against disposable fixtures, not assumed.
   */
  async diff(
    cwd: string,
    opts: { path?: string; staged?: boolean; commit?: string } = {},
  ): Promise<FileDiff[]> {
    const args = ["diff", "--no-color", "--no-ext-diff", "-M"];

    if (opts.commit) {
      const parents = await this.parentCount(cwd, opts.commit);
      if (parents === 0) {
        // Root: `show` against the empty tree is the only thing that works.
        args.length = 0;
        args.push("show", "--no-color", "--no-ext-diff", "-M", "--format=", opts.commit);
      } else if (parents > 1) {
        // Merge: against the first parent, i.e. "what landed on this branch".
        // That is the useful reading, and the UI labels it as such rather than
        // presenting it as the whole truth of the merge.
        args.push(`${opts.commit}^1..${opts.commit}`);
      } else {
        args.push(`${opts.commit}^!`);
      }
    } else if (opts.staged) {
      args.push("--cached");
    }

    if (opts.path) args.push("--", opts.path);
    try {
      return parseDiff(await git(cwd, args));
    } catch {
      return [];
    }
  }

  /** Content of an untracked file, rendered as an all-additions diff. */
  async untrackedDiff(cwd: string, path: string): Promise<FileDiff | null> {
    try {
      const out = await git(cwd, [
        "diff", "--no-color", "--no-index", "-M", "--", "/dev/null", path,
      ]).catch((e: { stdout?: string }) => e.stdout ?? "");
      const [file] = parseDiff(out);
      return file ?? null;
    } catch {
      return null;
    }
  }

  async log(cwd: string, limit = 50): Promise<
    { oid: string; short: string; subject: string; author: string; when: string }[]
  > {
    try {
      // \x1f between fields, \x1e between records: neither occurs in real text.
      const out = await git(cwd, [
        "log", `-${limit}`, "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e",
      ]);
      return out
        .split("\x1e")
        .map((r) => r.replace(/^\n/, ""))
        .filter(Boolean)
        .map((rec) => {
          const [oid = "", short = "", subject = "", author = "", when = ""] = rec.split("\x1f");
          return { oid, short, subject, author, when };
        });
    } catch {
      return [];
    }
  }
}
