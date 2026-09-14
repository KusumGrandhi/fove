/**
 * Naming what the editor is showing.
 *
 * Two concerns that both come down to "which file is this, exactly":
 *
 *   - a tab strip of basenames is useless the moment two of them are
 *     `index.ts`, so labels grow leftwards until they are distinct;
 *   - a breadcrumb answers the same question for the file on screen, without
 *     making you hover a tooltip to read a path you are looking straight at.
 *
 * Both are pure path arithmetic, so they live here rather than in the pane.
 */

/** Path segments, with empty ones dropped so "a//b" and a trailing "/" behave. */
function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * A distinct label for every path, as short as it can be.
 *
 * The basename alone where it is unique; otherwise one more parent directory
 * at a time until the collision is broken. Two files that differ only in a
 * directory six levels up really do need six levels to tell apart, and showing
 * that is better than showing two tabs that read identically.
 *
 * Paths that are equal have equal labels -- the caller keys tabs by path, so
 * that case cannot reach the screen, and looping forever over it would.
 */
export function disambiguate(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const byBase = new Map<string, string[]>();

  for (const p of paths) {
    const base = segments(p).pop() ?? p;
    const group = byBase.get(base);
    if (group) group.push(p);
    else byBase.set(base, [p]);
  }

  for (const [base, group] of byBase) {
    const unique = [...new Set(group)];
    if (unique.length === 1) {
      for (const p of group) out.set(p, base);
      continue;
    }
    // Grow every colliding path together, so the labels stay comparable in
    // length rather than one showing a full path beside a bare name.
    const parts = unique.map(segments);
    const depth = Math.max(...parts.map((s) => s.length));
    for (let take = 2; take <= depth; take++) {
      const labels = parts.map((s) => s.slice(-take).join("/"));
      if (new Set(labels).size === unique.length || take === depth) {
        unique.forEach((p, i) => out.set(p, labels[i]!));
        break;
      }
    }
  }

  return out;
}

export interface Crumb {
  /** The segment as shown. */
  name: string;
  /** Absolute path of that segment, so clicking it can act on it. */
  path: string;
  /** The last crumb is the file itself rather than a directory. */
  leaf: boolean;
}

/**
 * The path of `file` as clickable segments, relative to `root` where it can be.
 *
 * A file outside the root -- another worktree, an absolute path Claude asked
 * for -- gets the whole path instead of a wrong-looking relative one with
 * `../` in it. Knowing where you are matters more there, not less.
 */
export function breadcrumb(root: string, file: string): Crumb[] {
  const rootSegs = segments(root);
  const fileSegs = segments(file);

  const inRoot =
    fileSegs.length > rootSegs.length &&
    rootSegs.every((s, i) => fileSegs[i] === s);

  const start = inRoot ? rootSegs.length : 0;
  const crumbs: Crumb[] = [];
  for (let i = start; i < fileSegs.length; i++) {
    crumbs.push({
      name: fileSegs[i]!,
      path: `/${fileSegs.slice(0, i + 1).join("/")}`,
      leaf: i === fileSegs.length - 1,
    });
  }
  return crumbs;
}

/**
 * The repo-relative path git wants, since `git show <rev>:<path>` resolves
 * against the repository root and not the process's cwd.
 *
 * Returns null for a file outside the root, which is the caller's signal that
 * there is no revision of it to ask for.
 */
export function relativeTo(root: string, file: string): string | null {
  const rootSegs = segments(root);
  const fileSegs = segments(file);
  if (fileSegs.length <= rootSegs.length) return null;
  if (!rootSegs.every((s, i) => fileSegs[i] === s)) return null;
  return fileSegs.slice(rootSegs.length).join("/");
}
