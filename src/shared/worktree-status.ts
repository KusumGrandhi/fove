/**
 * Deciding which worktree an agent is running in.
 *
 * Pure, because the interesting part is not reading the facts -- fove already
 * reads all three -- but joining them without lying. A session's `cwd` is
 * wherever the user happened to `cd`, which is very often *below* the worktree
 * root: a session started in `core/flask` belongs to the `core` worktree and
 * should be shown against it.
 *
 * That makes the join a longest-prefix match rather than an equality test, and
 * longest-prefix is exactly where a naive implementation goes wrong: worktrees
 * nest. `.warp/worktrees/core/AGENT` sits inside `core`, so a session in the
 * former is under *both* paths and must be attributed to the deeper one.
 */

/** The subset of `git worktree list` this module needs. */
export interface WorktreeLike {
  path: string;
}

/** The subset of a live Claude session this module needs. */
export interface SessionLike {
  cwd: string;
}

/**
 * Whether `child` is `parent` or sits inside it.
 *
 * The separator check is what stops `core-old` matching `core`: a plain
 * `startsWith` would call them the same worktree.
 */
export function isInside(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** Trailing slashes are not meaningful in a path; a trailing `/` root is. */
function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Count the live sessions attributable to each worktree.
 *
 * Returned keyed by the worktree's path exactly as given, so a caller can look
 * up its own records without re-normalizing.
 */
export function sessionsByWorktree(
  worktrees: readonly WorktreeLike[],
  sessions: readonly SessionLike[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of worktrees) counts.set(w.path, 0);

  for (const s of sessions) {
    if (!s.cwd) continue;
    // The deepest containing worktree wins. Worktrees nest -- a session in
    // `core/.warp/worktrees/AGENT` is inside `core` too -- and attributing it
    // to the outer one would mark the wrong row as busy.
    let best: WorktreeLike | null = null;
    for (const w of worktrees) {
      if (!isInside(w.path, s.cwd)) continue;
      if (!best || normalize(w.path).length > normalize(best.path).length) best = w;
    }
    if (best) counts.set(best.path, (counts.get(best.path) ?? 0) + 1);
  }
  return counts;
}
