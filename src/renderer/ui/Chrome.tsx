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
  /** Where to pin the fixed-position menu, measured from the button. */
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

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
        onClick={(e) => {
          // Measure at open time: the toolbar may have been scrolled, so the
          // button's viewport position is not fixed.
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 4, left: r.left });
          setOpen((v) => !v);
        }}
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
        <div style={{ ...menu, top: at.top, left: at.left }}>
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

/**
 * One entry in a ToolMenu. `hint` is the shortcut, shown right-aligned.
 *
 * An entry carrying `items` is a submenu: it opens a second level on hover
 * instead of acting, so `onSelect` is not used for those.
 */
export interface ToolMenuItem {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Nested entries. Present means this row opens a submenu. */
  items?: ToolMenuItem[];
  /** Marks the chosen entry in a submenu of alternatives. */
  checked?: boolean;
}

/**
 * A group of toolbar actions behind one labelled button.
 *
 * Opens on hover and closes when the pointer leaves the button *and* the menu
 * both -- the two are separate elements with a 4px gap between them, so
 * tracking either alone would shut the menu while the pointer crosses that
 * gap. A close is therefore deferred by a short grace period that any re-entry
 * cancels; a click still toggles, for anyone who would rather not hover.
 *
 * Keyboard shortcuts on the items keep working whether or not the menu is ever
 * opened -- the menu is for finding an action, not for issuing it.
 */
export function ToolMenu(props: {
  label: string;
  icon?: ReactNode;
  items: ToolMenuItem[];
  /** Explanatory line under the items, like LayoutMenu's. */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  /** Pending close, so crossing the gap to the menu does not dismiss it. */
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  /** Measure at open time: the toolbar scrolls, so the rect is not fixed. */
  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ top: r.bottom + 4, left: r.left });
    setOpen(true);
  };

  useEffect(() => cancelClose, []);

  // Dismiss on an outside click or Escape, like every other menu on the system.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node;
      if (!hostRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
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

  return (
    <div
      ref={hostRef}
      style={{ position: "relative", WebkitAppRegion: "no-drag" } as CSSProperties}
      onMouseEnter={(e) => { cancelClose(); openAt(e.currentTarget); }}
      onMouseLeave={scheduleClose}
    >
      <button
        onClick={(e) => {
          cancelClose();
          if (open) setOpen(false);
          else openAt(e.currentTarget);
        }}
        title={props.label}
        style={{ ...btn, color: open ? C.fg : C.dim, background: open ? C.chromeHi : "transparent" }}
      >
        {props.icon && <span style={{ fontSize: 13, lineHeight: 1 }}>{props.icon}</span>}
        <span>{props.label}</span>
        <span style={{ fontSize: 9, color: C.faint }}>▾</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          style={{ ...menu, top: at.top, left: at.left, minWidth: 210 }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {props.items.map((it) => (
            <MenuRow key={it.label} item={it} onDone={() => setOpen(false)} />
          ))}
          {props.note && <div style={menuNote}>{props.note}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * One row of a ToolMenu: an action, or a submenu that opens on hover.
 *
 * The submenu is positioned from the row's measured rect, like the parent
 * menu is from its button, and flips to the left when it would run off the
 * right edge of the window. It shares the parent's grace period by simply
 * living inside it -- the pointer never leaves the parent menu's subtree
 * while travelling into the submenu, so the parent's own close timer is
 * never armed.
 */
function MenuRow(props: { item: ToolMenuItem; onDone: () => void }) {
  const { item } = props;
  const [sub, setSub] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancel = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancel();
    closeTimer.current = window.setTimeout(() => setSub(null), 160);
  };
  useEffect(() => cancel, []);

  if (!item.items) {
    return (
      <button
        disabled={item.disabled}
        onClick={() => { props.onDone(); item.onSelect?.(); }}
        style={{
          ...menuItem,
          // A row, not LayoutMenu's stacked label+hint: these carry a
          // shortcut rather than a sentence of explanation.
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          opacity: item.disabled ? 0.35 : 1,
          cursor: item.disabled ? "default" : "pointer",
        }}
        onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = C.chromeHi; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        {item.icon && (
          <span style={{ fontSize: 13, lineHeight: 1, width: 15, color: C.dim }}>{item.icon}</span>
        )}
        <span style={{ color: C.fg, fontSize: 12, flex: 1 }}>{item.label}</span>
        {item.checked && <span style={{ color: C.accent, fontSize: 11 }}>✓</span>}
        {item.hint && <kbd style={kbdStyle}>{item.hint}</kbd>}
      </button>
    );
  }

  return (
    <div
      ref={rowRef}
      style={{ position: "relative" }}
      onMouseEnter={(e) => {
        cancel();
        const r = e.currentTarget.getBoundingClientRect();
        // Flip left when a right-hand submenu would leave the window.
        const width = 190;
        const spill = r.right + width > window.innerWidth;
        setSub({ top: r.top - 4, left: spill ? r.left - width : r.right + 2 });
      }}
      onMouseLeave={scheduleClose}
    >
      <div
        style={{
          ...menuItem, flexDirection: "row", alignItems: "center", gap: 8,
          background: sub ? C.chromeHi : "transparent",
        }}
      >
        {item.icon && (
          <span style={{ fontSize: 13, lineHeight: 1, width: 15, color: C.dim }}>{item.icon}</span>
        )}
        <span style={{ color: C.fg, fontSize: 12, flex: 1 }}>{item.label}</span>
        <span style={{ fontSize: 9, color: C.faint }}>▸</span>
      </div>

      {sub && (
        <div
          style={{ ...menu, top: sub.top, left: sub.left, minWidth: 190 }}
          onMouseEnter={cancel}
          onMouseLeave={scheduleClose}
        >
          {item.items.map((s) => (
            <MenuRow key={s.label} item={s} onDone={props.onDone} />
          ))}
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
  // Keeps its width so an over-wide toolbar scrolls instead of compressing
  // every button until the labels are unreadable.
  flexShrink: 0,
  transition: "background 90ms, color 90ms",
  // Buttons must stay clickable inside the draggable title bar.
  WebkitAppRegion: "no-drag",
} as CSSProperties;

/*
 * `fixed`, not `absolute`.
 *
 * The toolbar scrolls horizontally now that it can be wider than the window,
 * and a scroll container clips absolutely-positioned descendants -- which cut
 * the preset menu off at the toolbar's 39px height. Fixed positioning takes
 * the menu out of that box; `top`/`left` are set from the button's measured
 * rect when it opens.
 */
const menu: CSSProperties = {
  position: "fixed",
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
