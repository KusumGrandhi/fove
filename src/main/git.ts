/**
 * Git service. Read-only in Phase 2: it observes a repository, never mutates it.
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

  async status(cwd: string): Promise<RepoStatus | null> {
    try {
      return parseStatus(await git(cwd, ["status", "--porcelain=v2", "--branch", "-z"]));
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
   * Diff for the working tree, the index, or a specific commit.
   *
   * `staged` selects the index; `commit` overrides both and shows that commit's
   * own change. Untracked files are included via --no-index against /dev/null
   * only when explicitly asked, since that costs an extra process per file.
   */
  async diff(
    cwd: string,
    opts: { path?: string; staged?: boolean; commit?: string } = {},
  ): Promise<FileDiff[]> {
    const args = ["diff", "--no-color", "--no-ext-diff", "-M"];
    if (opts.commit) args.push(`${opts.commit}^!`);
    else if (opts.staged) args.push("--cached");
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
