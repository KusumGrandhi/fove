/**
 * App chrome: the frame the panes live inside.
 *
 * Every keyboard shortcut has a visible, clickable button here -- the keys stay
 * for speed, but nothing is discoverable only by knowing it already exists.
 */

import type { CSSProperties, ReactNode } from "react";

export const C = {
  bg: "#0b0b0f",
  chrome: "#16161c",
  chromeHi: "#1e1e26",
  panel: "#101014",
  line: "#26262f",
  fg: "#e6e6ea",
  dim: "#9a9aa3",
  faint: "#5a5a63",
  accent: "#2f6feb",
  green: "#3fb950",
  red: "#e5534b",
};

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
