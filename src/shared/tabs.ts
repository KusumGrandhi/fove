/**
 * Tab ordering with pinning.
 *
 * A pinned tab holds its exact position: pinned tabs occupy the front of the
 * bar in the order they were pinned, and nothing unpinned can displace them.
 * New tabs land after every pinned one, and closing a tab never reorders the
 * rest.
 *
 * Pure functions over a plain array, so the ordering rules are testable without
 * a UI -- the same reason the layout engine is separated.
 */

export interface Pinnable {
  id: string;
  pinned?: boolean;
}

/** Pinned first (stable), then the rest (stable). */
export function order<T extends Pinnable>(tabs: T[]): T[] {
  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);
  return [...pinned, ...loose];
}

/** Index of the first unpinned tab -- where a new tab belongs. */
export function firstLooseIndex<T extends Pinnable>(tabs: T[]): number {
  const i = tabs.findIndex((t) => !t.pinned);
  return i === -1 ? tabs.length : i;
}

/**
 * Insert a new tab after the pinned block, so pinned tabs keep their exact
 * positions even as tabs come and go.
 */
export function insert<T extends Pinnable>(tabs: T[], tab: T): T[] {
  const ordered = order(tabs);
  const at = firstLooseIndex(ordered);
  return [...ordered.slice(0, at), tab, ...ordered.slice(at)];
}

/**
 * Pin or unpin one tab.
 *
 * Pinning moves the tab to the end of the pinned block, which is what makes
 * "its exact spot" stable afterwards. Unpinning drops it to the front of the
 * loose block rather than leaving it stranded among pinned tabs.
 */
export function setPinned<T extends Pinnable>(tabs: T[], id: string, pinned: boolean): T[] {
  const target = tabs.find((t) => t.id === id);
  if (!target || !!target.pinned === pinned) return tabs;
  const updated = tabs.map((t) => (t.id === id ? { ...t, pinned } : t));
  const others = updated.filter((t) => t.id !== id);
  const moved = updated.find((t) => t.id === id)!;
  const at = pinned
    ? others.filter((t) => t.pinned).length // end of the pinned block
    : firstLooseIndex(order(others));       // front of the loose block
  const ordered = order(others);
  return [...ordered.slice(0, at), moved, ...ordered.slice(at)];
}

/** Move a tab to a new index, refusing moves that would break the pinned block. */
export function moveTab<T extends Pinnable>(tabs: T[], id: string, to: number): T[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return tabs;
  const tab = tabs[from]!;
  const pinnedCount = tabs.filter((t) => t.pinned).length;

  // A pinned tab may only move within the pinned block; a loose tab may not
  // move into it.
  const min = tab.pinned ? 0 : pinnedCount;
  const max = tab.pinned ? pinnedCount - 1 : tabs.length - 1;
  const target = Math.max(min, Math.min(max, to));
  if (target === from) return tabs;

  const rest = tabs.filter((t) => t.id !== id);
  return [...rest.slice(0, target), tab, ...rest.slice(target)];
}

/** Closing a tab must never reorder the survivors. */
export function close<T extends Pinnable>(tabs: T[], id: string): T[] {
  return tabs.filter((t) => t.id !== id);
}

/** The parts of a pane this module needs; the app's Pane is a superset. */
export interface EditorPaneish {
  kind: string;
  openPath?: string;
}

/** The parts of a tab this module needs. */
export interface PaneHolder<P> {
  panes: Record<string, P>;
}

/**
 * Record the file an editor pane is actually showing.
 *
 * The persisted layout is what a popped-out window reads to rebuild a pane,
 * so it has to follow the editor rather than only the requests made *of* it.
 * Opening a file from the editor's own tree is invisible to the palette route
 * that used to be the sole writer of `openPath` -- which is why popping a pane
 * out reopened a stale file, or none at all.
 *
 * Returns the same array, and the same tab objects, when nothing changed: the
 * pane reports its path on mount with the file it was just told to open, and
 * persisting that would re-render, which would report again.
 */
export function noteEditorPath<P extends EditorPaneish, T extends PaneHolder<P>>(
  tabs: T[],
  paneId: string,
  path: string | null,
): T[] {
  const next = path ?? undefined;
  let changed = false;
  const out = tabs.map((t) => {
    const pane = t.panes[paneId];
    // Located by pane id across every tab rather than assuming the active
    // one: a background tab's editor still reports, and writing its path into
    // the wrong tab would corrupt both.
    if (!pane || pane.kind !== "editor") return t;
    if (pane.openPath === next) return t;
    changed = true;
    // `openNonce` is deliberately untouched: bumping it would feed a reopen
    // back into the pane that just reported the change.
    return { ...t, panes: { ...t.panes, [paneId]: { ...pane, openPath: next } } };
  });
  return changed ? out : tabs;
}
