/**
 * App chrome: the frame the panes live inside.
 *
 * Every keyboard shortcut has a visible, clickable button here -- the keys stay
 * for speed, but nothing is discoverable only by knowing it already exists.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * The app's colours, as CSS variable references.
 *
 * Every pane imports this, so routing the values through custom properties is
 * what lets a theme change repaint the whole app without remounting a single
 * pane -- and remounting would kill the PTY inside a running `claude` session.
 * The literal values live in themes.ts.
 */
import { TOKENS } from "./themes.js";

export const C = TOKENS;

/** A toolbar button that also advertises its shortcut. */
export function ToolButton(props: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const base = props.danger ? C.red : C.dim;
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.hint ? `${props.label}  (${props.hint})` : props.label}
      style={{ ...btn, color: base, opacity: props.disabled ? 0.35 : 1,
               cursor: props.disabled ? "default" : "pointer" }}
      onMouseEnter={(e) => {
        if (props.disabled) return;
        e.currentTarget.style.background = C.chromeHi;
        e.currentTarget.style.color = props.danger ? "#ff6b61" : C.fg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = base;
      }}
    >
      {props.icon && <span style={{ fontSize: 13, lineHeight: 1 }}>{props.icon}</span>}
      <span>{props.label}</span>
      {props.hint && <kbd style={kbdStyle}>{props.hint}</kbd>}
    </button>
  );
}

/**
 * The starting-layout picker.
 *
 * A dropdown rather than a cycling button: with three presets, cycling means
 * two wrong stops on the way to the one you wanted, and each stop rearranges
 * the workspace.
 */
export function LayoutMenu(props: {
  presets: { id: string; label: string; hint: string }[];
  current: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside click or Escape, like every other menu on the system.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label = props.presets.find((p) => p.id === props.current)?.label ?? "Layout";

  return (
    <div ref={hostRef} style={{ position: "relative", WebkitAppRegion: "no-drag" } as CSSProperties}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Starting layout for this workspace"
        style={{ ...btn, color: open ? C.fg : C.dim, background: open ? C.chromeHi : "transparent" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = C.chromeHi; }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? C.chromeHi : "transparent";
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>▦</span>
        <span>{label}</span>
        <span style={{ fontSize: 9, color: C.faint }}>▾</span>
      </button>

      {open && (
        <div style={menu}>
          {props.presets.map((p) => (
            <button
              key={p.id}
              onClick={() => { setOpen(false); props.onPick(p.id); }}
              style={{ ...menuItem, background: p.id === props.current ? C.chromeHi : "transparent" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.chromeHi; }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = p.id === props.current ? C.chromeHi : "transparent";
              }}
            >
              <span style={{ color: C.fg, fontSize: 12 }}>{p.label}</span>
              <span style={{ color: C.faint, fontSize: 10.5, lineHeight: 1.4 }}>{p.hint}</span>
            </button>
          ))}
          <div style={menuNote}>
            Rearranges this workspace. Open panes of the same kind are kept.
          </div>
        </div>
      )}
    </div>
  );
}

export function Divider() {
  return <div style={{ width: 1, height: 18, background: C.line, margin: "0 5px", flexShrink: 0 }} />;
}

const btn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 9px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  fontFamily: "system-ui",
  fontSize: 12,
  lineHeight: "16px",
  whiteSpace: "nowrap",
  transition: "background 90ms, color 90ms",
  // Buttons must stay clickable inside the draggable title bar.
  WebkitAppRegion: "no-drag",
} as CSSProperties;

const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 80,
  minWidth: 268,
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  overflow: "hidden",
  padding: 4,
};

const menuItem: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  width: "100%",
  textAlign: "left",
  padding: "7px 9px",
  border: "1px solid transparent",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  fontFamily: "system-ui",
};

const menuNote: CSSProperties = {
  padding: "6px 9px 4px",
  marginTop: 2,
  borderTop: `1px solid ${C.line}`,
  color: C.faint,
  fontFamily: "system-ui",
  fontSize: 10,
  lineHeight: 1.45,
};

const kbdStyle: CSSProperties = {
  fontFamily: "system-ui",
  fontSize: 10,
  color: C.faint,
  border: `1px solid ${C.line}`,
  borderRadius: 3,
  padding: "0 4px",
  marginLeft: 2,
};
