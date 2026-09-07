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

import type { GitService } from "./git.js";
import { liveSessions } from "./sessionLink.js";
import { sessionsByWorktree } from "../shared/worktree-status.js";

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
  constructor(private readonly git: GitService) {}

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

    const agents = sessionsByWorktree(trees, sessions);

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
        agents: agents.get(t.path) ?? 0,
      };
    });
  }
}
