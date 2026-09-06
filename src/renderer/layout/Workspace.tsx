/**
 * Renders the layout tree as absolutely-positioned panes with draggable
 * dividers between them.
 *
 * Absolute positioning from computed geometry (rather than nested flexbox)
 * keeps a single source of truth: `place()` decides where everything goes, and
 * the same numbers drive both rendering and hit-testing during a drag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dropEdge, dropPreview, edgeToSplit, movePane, place, resize, swapPanes,
  type DropEdge, type Node, type Rect,
} from "../../shared/layout.js";

export interface WorkspaceProps {
  tree: Node;
  onTreeChange: (next: Node) => void;
  /** Rendered inside each pane; `dragHandleProps` makes any element draggable. */
  renderPane: (
    paneId: string,
    focused: boolean,
    dragHandleProps: { onPointerDown: (e: React.PointerEvent) => void },
  ) => React.ReactNode;
  focusedPaneId?: string;
  onFocusPane: (paneId: string) => void;
  gap?: number;
}

interface PaneDrag {
  paneId: string;
  /** Pointer position, for the floating label. */
  x: number;
  y: number;
  /** Where the drop would land, once the pointer is over another pane. */
  over?: { paneId: string; edge: DropEdge; rect: Rect };
}

interface DragState {
  branchId: string;
  dir: "row" | "column";
  /** Container-relative origin of the branch being resized. */
  origin: number;
  extent: number;
}

export function Workspace(props: WorkspaceProps) {
  const gap = props.gap ?? 6;
  const hostRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const dragRef = useRef<DragState | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const paneDragRef = useRef<PaneDrag | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () =>
      setRect({ x: 0, y: 0, w: host.clientWidth, h: host.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const { panes, dividers } = place(props.tree, rect, gap);

  const onDividerDown = useCallback(
    (e: React.PointerEvent, branchId: string, dir: "row" | "column") => {
      e.preventDefault();
      if (!hostRef.current) return;
      // Resize is relative to the branch's own box, not the window, so nested
      // splits drag correctly.
      const branchRect = branchRectFor(props.tree, branchId, rect, gap);
      dragRef.current = {
        branchId,
        dir,
        origin: dir === "row" ? branchRect.x : branchRect.y,
        extent: dir === "row" ? branchRect.w : branchRect.h,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [props.tree, rect, gap],
  );

  /** Begin dragging a pane. Bound to the pane header via dragHandleProps. */
  const startPaneDrag = useCallback(
    (paneId: string) => (e: React.PointerEvent) => {
      // Left button only; ignore clicks on the header's own buttons.
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const host = hostRef.current;
      if (!host) return;
      const box = host.getBoundingClientRect();
      const next: PaneDrag = { paneId, x: e.clientX - box.left, y: e.clientY - box.top };
      paneDragRef.current = next;
      setPaneDrag(next);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const host = hostRef.current;
      if (!host) return;
      const box = host.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;

      // Dragging a pane onto another pane.
      const pd = paneDragRef.current;
      if (pd) {
        const target = panes.find(
          (p) => px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h,
        );
        const over =
          target && target.paneId !== pd.paneId
            ? { paneId: target.paneId, edge: dropEdge(target, px, py), rect: target }
            : undefined;
        const next: PaneDrag = { ...pd, x: px, y: py, over };
        paneDragRef.current = next;
        setPaneDrag(next);
        return;
      }

      // Dragging a divider.
      const drag = dragRef.current;
      if (!drag) return;
      const pos = drag.dir === "row" ? px : py;
      const usable = Math.max(1, drag.extent - gap);
      props.onTreeChange(resize(props.tree, drag.branchId, (pos - drag.origin) / usable));
    },
    [gap, props, panes],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const pd = paneDragRef.current;
      if (pd) {
        paneDragRef.current = null;
        setPaneDrag(null);
        if (pd.over) {
          const split = edgeToSplit(pd.over.edge);
          props.onTreeChange(
            split
              ? movePane(props.tree, pd.paneId, pd.over.paneId, split.dir, split.before)
              : swapPanes(props.tree, pd.paneId, pd.over.paneId),
          );
        }
      }
      dragRef.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be gone.
      }
    },
    [props],
  );

  return (
    <div
      ref={hostRef}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {panes.map((p) => {
        const focused = p.paneId === props.focusedPaneId;
        return (
          <div
            key={p.paneId}
            data-pane={p.paneId}
            onMouseDown={() => props.onFocusPane(p.paneId)}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: p.w,
              height: p.h,
              overflow: "hidden",
              borderRadius: 6,
              outline: focused ? "1px solid #2f6feb" : "1px solid #1c1c22",
              background: "#0d0d11",
            }}
          >
            {props.renderPane(p.paneId, focused, { onPointerDown: startPaneDrag(p.paneId) })}
          </div>
        );
      })}

      {/* Drop indicator: shows exactly where the pane will land. */}
      {paneDrag?.over && (() => {
        const prev = dropPreview(paneDrag.over.rect, paneDrag.over.edge);
        const swap = paneDrag.over.edge === "center";
        return (
          <div
            style={{
              position: "absolute", left: prev.x, top: prev.y, width: prev.w, height: prev.h,
              background: swap ? "rgba(210,153,34,0.16)" : "rgba(47,111,235,0.20)",
              border: `2px solid ${swap ? "#d29922" : "#2f6feb"}`,
              borderRadius: 6, pointerEvents: "none", zIndex: 20,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#e6e6ea", fontFamily: "system-ui", fontSize: 11,
            }}
          >
            {swap ? "swap" : ""}
          </div>
        );
      })()}

      {/* Floating label following the pointer while dragging. */}
      {paneDrag && (
        <div
          style={{
            position: "absolute", left: paneDrag.x + 12, top: paneDrag.y + 12,
            padding: "2px 8px", background: "#1e1e26", border: "1px solid #2f6feb",
            borderRadius: 5, color: "#e6e6ea", fontFamily: "system-ui", fontSize: 11,
            pointerEvents: "none", zIndex: 30,
          }}
        >
          moving pane
        </div>
      )}

      {dividers.map((d) => (
        <div
          key={d.branchId}
          onPointerDown={(e) => onDividerDown(e, d.branchId, d.dir)}
          style={{
            position: "absolute",
            left: d.dir === "row" ? d.x - 2 : d.x,
            top: d.dir === "row" ? d.y : d.y - 2,
            width: d.dir === "row" ? d.w + 4 : d.w,
            height: d.dir === "row" ? d.h : d.h + 4,
            cursor: d.dir === "row" ? "col-resize" : "row-resize",
            zIndex: 10,
          }}
        />
      ))}
    </div>
  );
}

// Helpers -------------------------------------------------------------------

/** Walk the tree to find the rect a given branch occupies. */
function branchRectFor(node: Node, branchId: string, rect: Rect, gap: number): Rect {
  if (node.kind === "leaf") return rect;
  if (node.id === branchId) return rect;
  const horizontal = node.dir === "row";
  const usable = Math.max(0, (horizontal ? rect.w : rect.h) - gap);
  const aSize = usable * node.ratio;
  const aRect: Rect = horizontal ? { ...rect, w: aSize } : { ...rect, h: aSize };
  const bRect: Rect = horizontal
    ? { ...rect, x: rect.x + aSize + gap, w: usable - aSize }
    : { ...rect, y: rect.y + aSize + gap, h: usable - aSize };
  const inA = containsBranch(node.a, branchId);
  return inA ? branchRectFor(node.a, branchId, aRect, gap) : branchRectFor(node.b, branchId, bRect, gap);
}

function containsBranch(node: Node, branchId: string): boolean {
  if (node.kind === "leaf") return false;
  if (node.id === branchId) return true;
  return containsBranch(node.a, branchId) || containsBranch(node.b, branchId);
}
