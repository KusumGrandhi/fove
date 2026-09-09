/**
 * Flattening a lazily-loaded directory tree into rows.
 *
 * The editor's sidebar shows one root and expands directories in place, so
 * what it renders is a flat list of rows carrying a depth -- not nested
 * elements. Keeping that transform here, as pure data, means the expansion
 * and reveal rules are testable without Monaco, Electron or a real directory.
 *
 * Children are fetched per directory and cached by the caller; a directory
 * that is open but has no cache entry yet renders as open with no children,
 * which is what makes the load feel immediate rather than blocking.
 */

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export interface TreeRow extends TreeEntry {
  /** 0 for the root's own children, 1 for a level down, and so on. */
  depth: number;
  /** Directories only: whether this node's children are showing. */
  open: boolean;
}

/**
 * Depth-first flatten of `root`'s descendants, following `open`.
 *
 * `children` maps a directory path to its listing. A missing key means "not
 * loaded yet" and contributes no rows, so an expanded directory whose fetch
 * is still in flight simply shows nothing beneath it.
 */
export function flattenTree(
  root: string,
  children: ReadonlyMap<string, readonly TreeEntry[]>,
  open: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number): void => {
    for (const e of children.get(dir) ?? []) {
      const isOpen = e.dir && open.has(e.path);
      rows.push({ ...e, depth, open: isOpen });
      // Recursing only into open directories is what bounds the work: a
      // collapsed node costs nothing regardless of how much lives under it.
      if (isOpen) walk(e.path, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/**
 * Every directory between `root` and `path`, outermost first.
 *
 * This is the set a reveal has to open to make `path` visible. `path` itself
 * is never included -- revealing a file should not expand the file, and
 * revealing a directory should show it selected rather than opened.
 *
 * A `path` outside `root` yields nothing: there is no chain to open, and
 * guessing one would expand unrelated parts of the tree.
 */
export function ancestorsWithin(root: string, path: string): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (path === base) return [];
  if (!path.startsWith(`${base}/`)) return [];

  const rest = path.slice(base.length + 1).split("/");
  const out: string[] = [];
  let cur = base;
  // The last segment is the target itself, so it is deliberately skipped.
  for (const seg of rest.slice(0, -1)) {
    cur = `${cur}/${seg}`;
    out.push(cur);
  }
  return out;
}
