/**
 * App chrome: the frame the panes live inside.
 *
 * Every keyboard shortcut has a visible, clickable button here -- the keys stay
 * for speed, but nothing is discoverable only by knowing it already exists.
 */

import type { CSSProperties, ReactNode } from "react";

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

const kbdStyle: CSSProperties = {
  fontFamily: "system-ui",
  fontSize: 10,
  color: C.faint,
  border: `1px solid ${C.line}`,
  borderRadius: 3,
  padding: "0 4px",
  marginLeft: 2,
};
