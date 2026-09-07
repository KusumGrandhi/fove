/**
 * The command palette.
 *
 * Built general rather than as a worktree-specific list, because by now the
 * toolbar has fifteen buttons and the shortcut list is longer than anyone will
 * memorise. A palette is how that surface area stops being a hunt.
 *
 * The list is supplied by the caller as plain data, so this file knows nothing
 * about worktrees, panes or git -- it filters, ranks and renders. That keeps
 * the interesting logic (what a worktree's status *is*) out of a component and
 * in a module that can be tested.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "./Chrome.js";
import { rank, type Item } from "./palette-rank.js";

export type { Item as PaletteItem };

export function Palette(props: {
  items: Item[];
  /** Shown when the query is empty and nothing matches, e.g. "no worktrees". */
  empty?: string;
  placeholder?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => rank(props.items, query), [props.items, query]);

  // A filtered list is a new list: an out-of-range cursor would highlight
  // nothing and Enter would do nothing.
  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (item: Item | undefined): void => {
    if (!item) return;
    // Close first: an action that opens a tab should not race the palette's
    // own unmount, and every action here is fire-and-forget.
    props.onClose();
    item.run();
  };

  return (
    // The scrim closes on click, which is the expected way out of a palette.
    <div style={S.scrim} onMouseDown={props.onClose}>
      <div style={S.box} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder={props.placeholder ?? "Go to a worktree, or run a command…"}
          onChange={(e) => setQuery(e.target.value)}
          style={S.input}
          onKeyDown={(e) => {
            // The app's global shortcuts must not fire while typing here.
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(shown[cursor]);
            }
          }}
        />

        <div style={S.list} ref={listRef}>
          {shown.length === 0 && (
            <div style={S.none}>{query ? "no matches" : props.empty ?? "nothing here"}</div>
          )}
          {shown.map((item, i) => (
            <div
              key={item.id}
              style={{ ...S.row, ...(i === cursor ? S.rowOn : null) }}
              // Hover moves the cursor so mouse and keyboard never disagree
              // about which row Enter would take.
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
              title={item.detail ?? item.label}
            >
              <span style={S.icon}>{item.icon ?? ""}</span>
              <span style={S.label}>{item.label}</span>
              {item.badges?.map((b, n) => (
                <span key={n} style={{ ...S.badge, color: b.tone ?? C.faint }}>{b.text}</span>
              ))}
              <div style={{ flex: 1 }} />
              {item.hint && <span style={S.hint}>{item.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  scrim: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", justifyContent: "center", alignItems: "flex-start",
    paddingTop: "12vh", zIndex: 60,
  },
  box: {
    width: "min(620px, 88vw)", background: C.panel, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)", fontFamily: "system-ui", fontSize: 12,
  },
  input: {
    width: "100%", boxSizing: "border-box", background: "transparent", color: C.fg,
    border: "none", borderBottom: `1px solid ${C.line}`, padding: "11px 14px",
    fontSize: 13, outline: "none", fontFamily: "inherit",
  },
  list: { maxHeight: "52vh", overflow: "auto" },
  row: {
    display: "flex", alignItems: "center", gap: 8, padding: "6px 14px",
    cursor: "pointer", whiteSpace: "nowrap",
  },
  rowOn: { background: C.chromeHi },
  icon: { width: 15, textAlign: "center", color: C.faint, flexShrink: 0 },
  label: { overflow: "hidden", textOverflow: "ellipsis" },
  badge: { fontSize: 10, fontFamily: "Menlo, monospace", flexShrink: 0 },
  hint: { color: C.faint, fontSize: 10, flexShrink: 0 },
  none: { padding: "14px", color: C.faint, textAlign: "center" },
};
