/**
 * Renders the layout tree as absolutely-positioned panes with draggable
 * dividers between them.
 *
 * Absolute positioning from computed geometry (rather than nested flexbox)
 * keeps a single source of truth: `place()` decides where everything goes, and
 * the same numbers drive both rendering and hit-testing during a drag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { place, resize, type Node, type Rect } from "../../shared/layout.js";

export interface WorkspaceProps {
  tree: Node;
  onTreeChange: (next: Node) => void;
  renderPane: (paneId: string, focused: boolean) => React.ReactNode;
  focusedPaneId?: string;
  onFocusPane: (paneId: string) => void;
  gap?: number;
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

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const host = hostRef.current;
      if (!drag || !host) return;
      const box = host.getBoundingClientRect();
      const pos = drag.dir === "row" ? e.clientX - box.left : e.clientY - box.top;
      const usable = Math.max(1, drag.extent - gap);
      props.onTreeChange(resize(props.tree, drag.branchId, (pos - drag.origin) / usable));
    },
    [gap, props],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone.
    }
  }, []);

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
            {props.renderPane(p.paneId, focused)}
          </div>
        );
      })}

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
