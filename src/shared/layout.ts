/**
 * Layout engine: a binary split tree.
 *
 * Pure data + pure functions, deliberately free of React and Electron so the
 * fiddly parts -- splitting, resizing, closing, re-parenting -- are testable
 * without a UI. Drag-resize and drag-to-reparent are where apps like this
 * usually die, so they get proven here first.
 *
 *   Leaf   = one pane
 *   Branch = two children, a direction, and a ratio in (0,1)
 */

export type Dir = "row" | "column";

export interface Leaf {
  kind: "leaf";
  id: string;
  paneId: string;
}

export interface Branch {
  kind: "branch";
  id: string;
  dir: Dir;
  /** Fraction of the branch occupied by `a`. Clamped to [MIN_RATIO, 1-MIN_RATIO]. */
  ratio: number;
  a: Node;
  b: Node;
}

export type Node = Leaf | Branch;

/** A pane may not be squeezed below this fraction of its parent. */
export const MIN_RATIO = 0.1;

let counter = 0;
export const newId = (prefix = "n"): string => `${prefix}${++counter}_${Date.now().toString(36)}`;
/** Test seam: makes ids deterministic. */
export const __resetIds = (): void => { counter = 0; };

export const leaf = (paneId: string, id = newId("l")): Leaf => ({ kind: "leaf", id, paneId });

export const clampRatio = (r: number): number =>
  Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, r));

/** Depth-first list of every leaf, left-to-right / top-to-bottom. */
export function leaves(node: Node): Leaf[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export function findLeafByPane(node: Node, paneId: string): Leaf | undefined {
  return leaves(node).find((l) => l.paneId === paneId);
}

/** Replace one node by id, returning a new tree (structural sharing elsewhere). */
export function replace(node: Node, targetId: string, next: Node): Node {
  if (node.id === targetId) return next;
  if (node.kind === "leaf") return node;
  const a = replace(node.a, targetId, next);
  const b = replace(node.b, targetId, next);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Split the leaf holding `paneId`, putting `newPaneId` on the side given by
 * `before` (left/top when true).
 */
export function split(
  root: Node,
  paneId: string,
  newPaneId: string,
  dir: Dir,
  before = false,
): Node {
  const target = findLeafByPane(root, paneId);
  if (!target) return root;
  const fresh = leaf(newPaneId);
  const branch: Branch = {
    kind: "branch",
    id: newId("b"),
    dir,
    ratio: 0.5,
    a: before ? fresh : target,
    b: before ? target : fresh,
  };
  return replace(root, target.id, branch);
}

/**
 * Remove a pane. Its sibling takes the parent's place, which is what collapses
 * the tree correctly rather than leaving empty branches behind.
 * Returns null when the last pane is closed.
 */
export function closePane(root: Node, paneId: string): Node | null {
  const target = findLeafByPane(root, paneId);
  if (!target) return root;
  if (root.kind === "leaf") return root.paneId === paneId ? null : root;

  const prune = (node: Node): Node | null => {
    if (node.kind === "leaf") return node.paneId === paneId ? null : node;
    const a = prune(node.a);
    const b = prune(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return a === node.a && b === node.b ? node : { ...node, a, b };
  };
  return prune(root);
}

/** Set a branch's ratio, clamped so neither side can be crushed. */
export function resize(root: Node, branchId: string, ratio: number): Node {
  if (root.kind === "leaf") return root;
  if (root.id === branchId) return { ...root, ratio: clampRatio(ratio) };
  const a = resize(root.a, branchId, ratio);
  const b = resize(root.b, branchId, ratio);
  return a === root.a && b === root.b ? root : { ...root, a, b };
}

/**
 * Move an existing pane next to another one (drag-to-reparent).
 * Removing first, then splitting, keeps the tree valid even when the source
 * and target share a parent.
 */
export function movePane(
  root: Node,
  paneId: string,
  targetPaneId: string,
  dir: Dir,
  before = false,
): Node {
  if (paneId === targetPaneId) return root;
  const without = closePane(root, paneId);
  if (!without) return root;
  if (!findLeafByPane(without, targetPaneId)) return root; // target went with it
  return split(without, targetPaneId, paneId, dir, before);
}

/** Every pane id currently in the tree. */
export const paneIds = (node: Node): string[] => leaves(node).map((l) => l.paneId);

/** Structural check used by tests and by restore-from-disk. */
export function isValid(node: Node): boolean {
  if (node.kind === "leaf") return typeof node.paneId === "string" && node.paneId.length > 0;
  if (node.ratio < MIN_RATIO || node.ratio > 1 - MIN_RATIO) return false;
  if (node.a === node.b) return false;
  const ids = paneIds(node);
  if (new Set(ids).size !== ids.length) return false; // no pane may appear twice
  return isValid(node.a) && isValid(node.b);
}

/** Geometry for rendering and for hit-testing drag handles. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface PlacedLeaf extends Rect { paneId: string; leafId: string }
export interface PlacedDivider extends Rect { branchId: string; dir: Dir }

/**
 * Resolve the tree to absolute rects. `gap` is the divider thickness, taken out
 * of the middle so panes never overlap their handle.
 */
export function place(
  node: Node,
  rect: Rect,
  gap = 4,
): { panes: PlacedLeaf[]; dividers: PlacedDivider[] } {
  if (node.kind === "leaf") {
    return { panes: [{ ...rect, paneId: node.paneId, leafId: node.id }], dividers: [] };
  }
  const horizontal = node.dir === "row";
  const total = horizontal ? rect.w : rect.h;
  const usable = Math.max(0, total - gap);
  const aSize = usable * node.ratio;
  const bSize = usable - aSize;

  const aRect: Rect = horizontal
    ? { ...rect, w: aSize }
    : { ...rect, h: aSize };
  const bRect: Rect = horizontal
    ? { ...rect, x: rect.x + aSize + gap, w: bSize }
    : { ...rect, y: rect.y + aSize + gap, h: bSize };
  const divider: PlacedDivider = horizontal
    ? { x: rect.x + aSize, y: rect.y, w: gap, h: rect.h, branchId: node.id, dir: node.dir }
    : { x: rect.x, y: rect.y + aSize, w: rect.w, h: gap, branchId: node.id, dir: node.dir };

  const A = place(node.a, aRect, gap);
  const B = place(node.b, bRect, gap);
  return {
    panes: [...A.panes, ...B.panes],
    dividers: [divider, ...A.dividers, ...B.dividers],
  };
}
