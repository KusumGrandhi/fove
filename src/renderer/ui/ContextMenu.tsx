/**
 * A right-click menu.
 *
 * Rendered in the app rather than through Electron's native menu API, because
 * a native menu is built in the main process and would need every item, its
 * enabled state and its handler shipped across IPC on each click. This keeps
 * the whole interaction in the component that owns the data.
 *
 * Positioning is clamped to the window, so a menu opened near the right or
 * bottom edge stays reachable instead of being half off-screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { C } from "./Chrome.js";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** A destructive item is coloured as a warning. */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separated?: boolean;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });

  // Clamp after mount, when the real size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(props.x, window.innerWidth - width - 8),
      y: Math.min(props.y, window.innerHeight - height - 8),
    });
  }, [props.x, props.y]);

  // Escape, and any click outside, dismiss. Capture phase so the click that
  // closes the menu does not also land on whatever is underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [props]);

  return (
    <div ref={ref} style={{ ...S.menu, left: pos.x, top: pos.y }}>
      {props.items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separated && <div style={S.sep} />}
          <div
            style={{
              ...S.item,
              color: item.disabled ? C.faint : item.danger ? "#f85149" : C.fg,
              cursor: item.disabled ? "default" : "pointer",
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (item.disabled) return;
              item.onSelect();
              props.onClose();
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  menu: {
    position: "fixed",
    minWidth: 178,
    padding: "4px 0",
    background: "#1a1a21",
    border: "1px solid #33333d",
    borderRadius: 6,
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
    zIndex: 200,
    fontFamily: "system-ui",
    fontSize: 12,
    animation: "fove-fade-in 90ms ease-out",
  },
  item: { padding: "4px 12px", whiteSpace: "nowrap" },
  sep: { height: 1, background: "#2a2a34", margin: "4px 0" },
};
