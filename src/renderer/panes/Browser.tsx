/**
 * The browser pane.
 *
 * Unusual among the panes: it renders almost nothing. The page itself is a
 * native `WebContentsView` living in the main process, positioned *over* this
 * component -- so what this file draws is the chrome around a hole, and its
 * real job is telling the main process where that hole is.
 *
 * Everything follows from that:
 *   - A `ResizeObserver` reports bounds on every layout change. Splitting a
 *     pane, resizing the window or dragging a divider all move the hole, and a
 *     native view does not move with it.
 *   - Unmounting reports no bounds *and* closes the view. A native view has no
 *     z-index; left behind it would paint over whatever replaced this pane.
 *   - `getBoundingClientRect` is relative to the viewport, which is exactly the
 *     coordinate space the window's content view uses, so no conversion.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../ui/Chrome.js";

interface ConsoleEntry {
  level: "info" | "warning" | "error" | "debug";
  text: string;
  source?: string;
  line?: number;
  at: number;
}

interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  error?: string;
  at: number;
}

interface State {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Where a dev server usually is, offered rather than typed. */
const GUESSES = ["http://localhost:5000", "http://localhost:5173", "http://localhost:3000"];

export function BrowserPane(props: { paneId: string; visible?: boolean }) {
  const holeRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [tray, setTray] = useState<"none" | "console" | "network">("none");
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const [net, setNet] = useState<NetworkEntry[]>([]);

  /** Tell the main process where the page should sit, or that it should hide. */
  const report = useCallback(() => {
    const el = holeRef.current;
    if (!el || props.visible === false) {
      window.th.browserBounds(props.paneId, null);
      return;
    }
    const r = el.getBoundingClientRect();
    // A pane in a background tab has a zero-sized rect, which the main process
    // reads as "hide" -- so this one check covers both cases.
    window.th.browserBounds(props.paneId, {
      x: r.left, y: r.top, width: r.width, height: r.height,
    });
  }, [props.paneId, props.visible]);

  useEffect(() => {
    report();
    const el = holeRef.current;
    // ResizeObserver catches a divider drag; the window listeners catch a move
    // or a resize that changes position without changing this element's size.
    const ro = new ResizeObserver(report);
    if (el) ro.observe(el);
    window.addEventListener("resize", report);
    // A layout change elsewhere in the app can move this pane without
    // resizing it, and there is no event for that -- so poll, cheaply.
    const timer = setInterval(report, 500);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      clearInterval(timer);
    };
  }, [report]);

  // Closing the pane must destroy the view: a native view left behind would
  // paint over whatever takes this pane's place.
  useEffect(() => () => window.th.browserClose(props.paneId), [props.paneId]);

  useEffect(() => {
    const off = window.th.onBrowserState((id, s) => {
      if (id !== props.paneId) return;
      const next = s as State;
      setState(next);
      // Only overwrite the box when the user is not mid-edit, or typing a URL
      // while a page redirects would fight the user for the field.
      setDraft((d) => (document.activeElement === inputRef.current ? d : next.url));
    });
    return off;
  }, [props.paneId]);

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Pull the capture buffers from the main process.
   *
   * Polled whether or not a tray is open, because the counts on the tabs are
   * the *warning* -- pulling only while a tray is open meant the badge could
   * not appear until you had already gone looking, which is exactly backwards.
   *
   * Slower when closed: with no tray showing, the only consumer is a number.
   */
  useEffect(() => {
    let live = true;
    const pull = async (): Promise<void> => {
      const [c, n] = await Promise.all([
        window.th.browserConsole(props.paneId),
        window.th.browserNetwork(props.paneId),
      ]);
      if (!live) return;
      setLogs(c as ConsoleEntry[]);
      setNet(n as NetworkEntry[]);
    };
    void pull();
    const timer = setInterval(() => void pull(), tray === "none" ? 2000 : 1000);
    return () => { live = false; clearInterval(timer); };
  }, [tray, props.paneId]);

  const go = (url: string): void => {
    const ok = window.th.browserNavigate(props.paneId, url);
    void ok;
  };

  const errors = logs.filter((l) => l.level === "error").length;
  const failures = net.length;

  return (
    <div style={S.pane}>
      <div style={S.bar}>
        <button style={S.nav} disabled={!state?.canGoBack}
          onClick={() => window.th.browserBack(props.paneId)} title="Back">‹</button>
        <button style={S.nav} disabled={!state?.canGoForward}
          onClick={() => window.th.browserForward(props.paneId)} title="Forward">›</button>
        <button style={S.nav} title="Reload (hold ⇧ to bypass the cache)"
          onClick={(e) => window.th.browserReload(props.paneId, e.shiftKey)}>
          {state?.loading ? "×" : "⟳"}
        </button>
        <input
          ref={inputRef}
          style={S.url}
          value={draft}
          placeholder="localhost:5000"
          onChange={(e) => setDraft(e.target.value)}
          // The app's shortcuts must not fire while typing a URL.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") go(draft);
          }}
        />
        <button style={S.nav} title="Developer tools"
          onClick={() => window.th.browserDevTools(props.paneId)}>⚙</button>
      </div>

      {!state?.url && (
        <div style={S.guesses}>
          <span style={{ color: C.faint }}>try</span>
          {GUESSES.map((g) => (
            <button key={g} style={S.guess} onClick={() => { setDraft(g); go(g); }}>
              {g.replace("http://", "")}
            </button>
          ))}
        </div>
      )}

      {/* The page is painted over this element by the main process. */}
      <div ref={holeRef} style={S.hole} />

      <div style={S.tabs}>
        <TrayTab on={tray === "console"} onClick={() => setTray((t) => t === "console" ? "none" : "console")}
          tone={errors > 0 ? C.red : undefined}>
          console{errors > 0 ? ` (${errors})` : ""}
        </TrayTab>
        <TrayTab on={tray === "network"} onClick={() => setTray((t) => t === "network" ? "none" : "network")}
          tone={failures > 0 ? C.red : undefined}>
          failed requests{failures > 0 ? ` (${failures})` : ""}
        </TrayTab>
        <div style={{ flex: 1 }} />
        {tray !== "none" && (
          <button style={S.clear} onClick={() => {
            window.th.browserClear(props.paneId);
            setLogs([]); setNet([]);
          }}>clear</button>
        )}
      </div>

      {tray === "console" && (
        <div style={S.tray}>
          {logs.length === 0 && <div style={S.none}>nothing logged</div>}
          {logs.map((l, i) => (
            <div key={i} style={{ ...S.row, color: toneFor(l.level) }}>
              <span style={S.rowText}>{l.text}</span>
              {/* Inline scripts report no source; ":4" alone says nothing. */}
              {l.source && <span style={S.rowWhere}>{short(l.source)}:{l.line}</span>}
            </div>
          ))}
        </div>
      )}

      {tray === "network" && (
        <div style={S.tray}>
          {net.length === 0 && <div style={S.none}>no failed requests</div>}
          {net.map((n, i) => (
            <div key={i} style={{ ...S.row, color: C.red }}>
              <span style={S.status}>{n.status ?? n.error ?? "?"}</span>
              <span style={S.rowText}>{n.method} {n.url}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrayTab(props: { on: boolean; tone?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        ...S.trayTab,
        color: props.tone ?? (props.on ? C.fg : C.faint),
        borderBottomColor: props.on ? C.accent : "transparent",
      }}
    >
      {props.children}
    </button>
  );
}

const toneFor = (level: ConsoleEntry["level"]): string =>
  level === "error" ? C.red : level === "warning" ? C.yellow : C.dim;

/** Just the filename: a bundler URL is otherwise longer than the message. */
const short = (url: string): string => url.split("/").pop() ?? url;

const S: Record<string, React.CSSProperties> = {
  pane: {
    display: "flex", flexDirection: "column", height: "100%", background: C.panel,
    color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden",
  },
  bar: {
    display: "flex", alignItems: "center", gap: 4, padding: "5px 7px",
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  nav: {
    width: 22, height: 20, borderRadius: 4, border: `1px solid ${C.line}`,
    background: "transparent", color: C.dim, cursor: "pointer", fontSize: 12,
    flexShrink: 0, padding: 0,
  },
  url: {
    flex: 1, minWidth: 0, background: C.bg, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 7px",
    fontSize: 11, outline: "none", fontFamily: "inherit",
  },
  guesses: {
    display: "flex", alignItems: "center", gap: 6, padding: "5px 9px",
    borderBottom: `1px solid ${C.line}`, fontSize: 11, flexShrink: 0,
  },
  guess: {
    padding: "2px 7px", borderRadius: 4, border: `1px solid ${C.line}`,
    background: "transparent", color: C.accent, fontSize: 11, cursor: "pointer",
    fontFamily: "Menlo, monospace",
  },
  // The page is painted over this. It must keep its space in the flex column,
  // which is why it has a flex-grow rather than being absolutely positioned.
  hole: { flex: 1, minHeight: 0, background: C.bg },
  tabs: {
    display: "flex", alignItems: "stretch", gap: 2, borderTop: `1px solid ${C.line}`,
    flexShrink: 0, padding: "0 6px",
  },
  trayTab: {
    background: "transparent", border: "none", borderBottom: "2px solid transparent",
    padding: "5px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
  },
  clear: {
    background: "transparent", border: "none", color: C.faint,
    fontSize: 10, cursor: "pointer", padding: "0 6px",
  },
  tray: {
    height: 150, overflow: "auto", borderTop: `1px solid ${C.line}`,
    fontFamily: "Menlo, monospace", fontSize: 11, flexShrink: 0,
  },
  row: { display: "flex", gap: 8, padding: "2px 9px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  rowText: { flex: 1, minWidth: 0 },
  rowWhere: { color: C.faint, flexShrink: 0 },
  status: { minWidth: 34, flexShrink: 0 },
  none: { padding: 11, color: C.faint, textAlign: "center", fontFamily: "system-ui" },
};
