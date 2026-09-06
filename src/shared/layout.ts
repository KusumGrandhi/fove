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

// --- drag & drop -----------------------------------------------------------

/** Which edge of a pane a drop would attach to. */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

/**
 * Decide the drop edge from a pointer position within a pane's rect.
 *
 * The outer `band` fraction of each side is an edge zone; anything nearer the
 * middle is "center" (swap with the target rather than split it). Whichever
 * edge the pointer is proportionally closest to wins, so a wide-but-short pane
 * still gets sensible top/bottom zones.
 */
export function dropEdge(
  rect: Rect,
  x: number,
  y: number,
  band = 0.3,
): DropEdge {
  if (rect.w <= 0 || rect.h <= 0) return "center";
  // Position within the pane, 0..1 on each axis.
  const px = (x - rect.x) / rect.w;
  const py = (y - rect.y) / rect.h;
  if (px < 0 || px > 1 || py < 0 || py > 1) return "center";

  const dist = { left: px, right: 1 - px, top: py, bottom: 1 - py };
  const [edge, value] = Object.entries(dist).sort((a, b) => a[1] - b[1])[0] as [DropEdge, number];
  return value < band ? edge : "center";
}

/** Translate a drop edge into the split arguments movePane expects. */
export function edgeToSplit(edge: DropEdge): { dir: Dir; before: boolean } | null {
  switch (edge) {
    case "left": return { dir: "row", before: true };
    case "right": return { dir: "row", before: false };
    case "top": return { dir: "column", before: true };
    case "bottom": return { dir: "column", before: false };
    case "center": return null;
  }
}

/**
 * Swap two panes in place, leaving the tree shape untouched.
 * This is what a "center" drop does.
 */
export function swapPanes(root: Node, a: string, b: string): Node {
  if (a === b) return root;
  const walk = (n: Node): Node => {
    if (n.kind === "leaf") {
      if (n.paneId === a) return { ...n, paneId: b };
      if (n.paneId === b) return { ...n, paneId: a };
      return n;
    }
    const A = walk(n.a);
    const B = walk(n.b);
    return A === n.a && B === n.b ? n : { ...n, a: A, b: B };
  };
  return walk(root);
}

/** Preview rect for the drop indicator overlay. */
export function dropPreview(rect: Rect, edge: DropEdge): Rect {
  const half = { ...rect };
  switch (edge) {
    case "left": return { ...half, w: rect.w / 2 };
    case "right": return { ...half, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top": return { ...half, h: rect.h / 2 };
    case "bottom": return { ...half, y: rect.y + rect.h / 2, h: rect.h / 2 };
    case "center": return rect;
  }
}

// --- pinning ---------------------------------------------------------------

/**
 * Pane pinning: "this pane stays where it is, and stays alive".
 *
 * Pins live outside the tree, as a set of pane ids, for two reasons: the tree
 * is rewritten wholesale on every split/close/move (so a flag inside it would
 * have to be carefully carried through each rewrite), and a pin is a property
 * of the *pane*, not of the geometry node that currently holds it.
 *
 * What a pin blocks:
 *   - moving the pane (dragging it somewhere else)
 *   - swapping it with another pane -- a swap relocates it just as a drag does,
 *     so blocking one and not the other would be a hole
 *   - closing it
 *
 * What a pin deliberately allows:
 *   - resizing, because a divider is shared with a neighbour and freezing it
 *     would freeze unpinned panes too
 *   - splitting off it, which adds a sibling while the pinned pane keeps both
 *     its content and its position in the tree
 */
export type Pins = ReadonlySet<string>;

export const isPinned = (pins: Pins, paneId: string): boolean => pins.has(paneId);

/** Toggle one pane's pin, returning a new set. */
export function setPanePinned(pins: Pins, paneId: string, pinned: boolean): Pins {
  if (pins.has(paneId) === pinned) return pins;
  const next = new Set(pins);
  if (pinned) next.add(paneId); else next.delete(paneId);
  return next;
}

/** Drop pins for panes that no longer exist, so the set can't leak forever. */
export function prunePins(pins: Pins, root: Node | null): Pins {
  const live = new Set(root ? paneIds(root) : []);
  const kept = [...pins].filter((id) => live.has(id));
  return kept.length === pins.size ? pins : new Set(kept);
}

/** A move is refused when either end is pinned: the source moves, the target is displaced. */
export function canMovePane(pins: Pins, paneId: string, targetPaneId: string): boolean {
  return !pins.has(paneId) && !pins.has(targetPaneId);
}

export const canClosePane = (pins: Pins, paneId: string): boolean => !pins.has(paneId);

/** movePane, refusing to relocate a pinned pane or displace a pinned target. */
export function movePaneChecked(
  root: Node,
  pins: Pins,
  paneId: string,
  targetPaneId: string,
  dir: Dir,
  before = false,
): Node {
  if (!canMovePane(pins, paneId, targetPaneId)) return root;
  return movePane(root, paneId, targetPaneId, dir, before);
}

/** swapPanes, refusing when either pane is pinned. */
export function swapPanesChecked(root: Node, pins: Pins, a: string, b: string): Node {
  if (!canMovePane(pins, a, b)) return root;
  return swapPanes(root, a, b);
}

/** closePane, refusing to close a pinned pane. */
export function closePaneChecked(root: Node, pins: Pins, paneId: string): Node | null {
  if (!canClosePane(pins, paneId)) return root;
  return closePane(root, paneId);
}
