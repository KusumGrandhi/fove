/**
 * Worktrees, with live status.
 *
 * Every fact here is already read somewhere in fove -- `git worktree list` in
 * `git.ts`, the dirty count from `status`, live sessions from
 * `sessionLink.ts`. The value is the join: seeing at a glance which checkout
 * has uncommitted work and which has an agent running in it, without opening
 * five tabs to find out.
 *
 * Status is gathered per worktree in parallel, because a `git status` on a
 * large repository is not instant and five of them in series is a visible
 * pause on a palette that should feel immediate.
 *
 * A worktree whose status cannot be read is still listed, with its counts
 * omitted rather than zeroed. Zero would be a lie -- it reads as "clean" when
 * the truth is "unknown", and the whole point of the list is deciding where to
 * go next.
 */

import { realpath } from "node:fs/promises";
import type { GitService } from "./git.js";
import type { GitWriteService } from "./gitWrite.js";
import { liveSessions } from "./sessionLink.js";
import { sessionsByWorktree } from "../shared/worktree-status.js";

/**
 * Resolve symlinks so two spellings of one directory compare equal.
 *
 * git reports worktree paths already resolved, but a caller's path often is
 * not: on macOS /var and /tmp are symlinks into /private, so a path that came
 * from a temp dir or a symlinked checkout would never match git's listing and
 * every lookup would miss. Falls back to the original path when the directory
 * has already gone, which is exactly when a prunable worktree is looked up.
 */
async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [ra, rb] = await Promise.all([
    realpath(a).catch(() => a),
    realpath(b).catch(() => b),
  ]);
  return ra === rb;
}

export interface WorktreeStatus {
  path: string;
  /** Directory name, for display. */
  name: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  prunable?: boolean;
  /** True for the worktree the request came from. */
  current?: boolean;
  /** Uncommitted files, staged or not. Undefined when status could not be read. */
  dirty?: number;
  /** Commits ahead of / behind the upstream, when there is one. */
  ahead?: number;
  behind?: number;
  /** Live Claude sessions running in this worktree. */
  agents: number;
}

export class WorktreeService {
  constructor(
    private readonly git: GitService,
    private readonly gitw: GitWriteService,
  ) {}

  /**
   * Every worktree of the repository containing `cwd`, with its live status.
   *
   * Returns an empty list outside a repository, which the palette shows as
   * "not a git repository" rather than as an error.
   */
  async list(cwd: string): Promise<WorktreeStatus[]> {
    const trees = await this.git.worktrees(cwd);
    if (trees.length === 0) return [];

    // Sessions are read once for the whole list: `liveSessions` scans a
    // directory and signals every pid in it, which is not work to repeat per
    // worktree.
    const [sessions, statuses] = await Promise.all([
      liveSessions().catch(() => []),
      Promise.all(trees.map((t) => this.git.status(t.path))),
    ]);

    // The join is textual, so both sides have to be spelled the same way, and
    // they are not by default: git resolves worktree paths, while a session
    // records the cwd its shell was started with -- /var/... against git's
    // /private/var/... on macOS. Unresolved, the prefix match silently misses
    // and the worktree looks idle. `remove` refuses on this count, so a miss
    // here is not a cosmetic undercount: it would delete a directory an agent
    // is still working in. Resolving happens here rather than in
    // `sessionsByWorktree` so that function stays pure.
    const [paths, cwds] = await Promise.all([
      Promise.all(trees.map((t) => realpath(t.path).catch(() => t.path))),
      Promise.all(sessions.map((s) => realpath(s.cwd).catch(() => s.cwd))),
    ]);
    const agents = sessionsByWorktree(
      paths.map((path) => ({ path })),
      cwds.map((cwd) => ({ cwd })),
    );

    return trees.map((t, i) => {
      const status = statuses[i];
      return {
        path: t.path,
        name: t.path.split("/").filter(Boolean).pop() ?? t.path,
        // A detached worktree has no branch; the short head is the useful
        // thing to show in its place.
        branch: t.branch ?? (t.head ? t.head.slice(0, 8) : undefined),
        detached: t.detached,
        locked: t.locked,
        prunable: t.prunable,
        current: t.current,
        dirty: status ? status.files.length : undefined,
        ahead: status?.ahead,
        behind: status?.behind,
        agents: agents.get(paths[i] ?? t.path) ?? 0,
      };
    });
  }

  /**
   * Close a worktree: detach it from the repository and delete its directory.
   *
   * Refusals come before git does anything, because `git worktree remove` is
   * not reversible and its own guards do not cover everything that matters
   * here. Four cases are refused outright:
   *
   * - The main worktree. Removing it would take the repository with it.
   * - The caller's own worktree. Deleting the directory fove is pointed at
   *   leaves the app looking at a path that no longer exists.
   * - A locked worktree. The lock is someone's explicit "not this one".
   * - A worktree with a live agent in it. The session would lose its cwd
   *   mid-run, and the user cannot see that from the button.
   *
   * Uncommitted work is the one case `force` may override, and the caller has
   * to ask for it: git refuses a dirty tree by default, and that default is
   * right. That refusal is flagged with `retryWithForce` so a UI can tell the
   * one recoverable "no" from the four final ones without reading the message
   * -- offering to discard work in answer to a refusal that was really about a
   * lock or a live agent would ask the user to consent to a loss that is not
   * even the problem. The branch is always left alone -- closing a checkout is
   * not the same as deleting the work on it, and a branch is cheap to check
   * out again.
   */
  async remove(
    cwd: string,
    path: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string; retryWithForce?: boolean }> {
    const trees = await this.list(cwd);
    const matches = await Promise.all(trees.map((t) => samePath(t.path, path)));
    const index = matches.indexOf(true);
    const target = index === -1 ? undefined : trees[index];
    if (!target) return { ok: false, error: "no such worktree" };

    // `git worktree list` puts the main worktree first; it is the only one
    // whose removal git itself would not stop.
    if (index === 0) return { ok: false, error: "cannot close the main worktree" };
    if (target.current) return { ok: false, error: "cannot close the worktree you are in" };
    if (target.locked) return { ok: false, error: "worktree is locked — unlock it first" };
    if (target.agents > 0) {
      const s = target.agents === 1 ? "" : "s";
      return { ok: false, error: `${target.agents} live session${s} — close them first` };
    }
    if (target.dirty && target.dirty > 0 && !opts.force) {
      return {
        ok: false,
        error: `${target.dirty} uncommitted file(s) — closing would discard them`,
        retryWithForce: true,
      };
    }

    const r = await this.gitw.worktreeRemove(cwd, path, opts.force);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "git worktree remove failed" };
  }
}
