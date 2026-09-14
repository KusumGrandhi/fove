/**
 * A single pane, alone in its own window.
 *
 * Rendered instead of the app shell when the window was opened with
 * `?popout=<paneId>`. It deliberately has no tabs, no toolbar and no stats
 * rail: the point of moving a pane to a second screen is to see more of *it*,
 * not to duplicate the chrome that is already on the first screen.
 *
 * The PTY is not restarted. It lives in the main process, addressed by pane
 * id, so this window attaches to the session that is already running: the
 * scrollback is replayed on mount and `pty:data` continues to arrive. A
 * `claude` session moved here keeps its context and its history.
 */

import { useEffect, useState } from "react";
import { TerminalPane } from "./panes/Terminal.js";
import { EditorPane } from "./panes/Editor.js";
import { GitStatusPane } from "./panes/GitStatus.js";
import { AgentsPane } from "./panes/Agents.js";
import { ConfigPane } from "./panes/Config.js";
import { C } from "./ui/Chrome.js";
import { applyTheme, DEFAULT_THEME } from "./ui/themes.js";

/** What the main window told us about this pane, via the persisted layout. */
interface PoppedPane {
  kind: "shell" | "claude" | "git" | "editor" | "agents" | "config";
  title: string;
  cwd: string;
  openPath?: string;
  /** An editor pane popped out while showing a diff reopens as that diff. */
  openDiff?: { path: string; rev: string; revLabel?: string };
}

export function PopoutWindow(props: { paneId: string }) {
  const [pane, setPane] = useState<PoppedPane | null>(null);
  const [missing, setMissing] = useState(false);

  // The theme is a per-machine preference, so the popped window matches the
  // main one without any message passing.
  useEffect(() => {
    applyTheme(localStorage.getItem("fove.theme") ?? DEFAULT_THEME);
  }, []);

  /**
   * Find this pane in the saved layout.
   *
   * The layout is the single source of truth for what a pane *is* — the main
   * window persists it on every change — so reading it avoids a second
   * channel that could disagree with the first.
   */
  useEffect(() => {
    void (async () => {
      const saved = (await window.th.loadLayout()) as {
        tabs?: { cwd?: string; panes?: Record<string, PoppedPane & { id: string }> }[];
      } | null;
      for (const tab of saved?.tabs ?? []) {
        const found = tab.panes?.[props.paneId];
        if (found) {
          setPane({ ...found, cwd: found.cwd || tab.cwd || "" });
          return;
        }
      }
      setMissing(true);
    })();
  }, [props.paneId]);

  if (missing) {
    return (
      <div style={S.empty}>
        This pane is no longer in the layout. Close this window.
      </div>
    );
  }
  if (!pane) return <div style={S.empty}>attaching…</div>;

  return (
    <div style={S.shell}>
      {/* A thin bar so the window is identifiable in a stack, and draggable
          by its whole width rather than only the traffic-light strip. */}
      <div style={S.bar}>
        <span style={{ color: C.faint }}>{glyph(pane.kind)}</span>
        <span style={{ color: C.fg }}>{pane.title || pane.kind}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: C.faint, fontSize: 10 }}>
          {pane.cwd.split("/").pop()}
        </span>
      </div>

      <div style={S.body}>
        {pane.kind === "git" ? (
          <GitStatusPane cwd={pane.cwd} />
        ) : pane.kind === "editor" ? (
          <EditorPane cwd={pane.cwd} initialPath={pane.openPath} initialDiff={pane.openDiff} />
        ) : pane.kind === "agents" ? (
          <AgentsPane cwd={pane.cwd} />
        ) : pane.kind === "config" ? (
          <ConfigPane cwd={pane.cwd} />
        ) : (
          <TerminalPane
            paneId={props.paneId}
            // Attaches to the running PTY: spawn() returns the existing
            // session and replays its scrollback rather than starting a shell.
            cmd={pane.kind === "claude" ? "claude" : undefined}
            args={pane.kind === "claude" ? [] : undefined}
            cwd={pane.cwd}
            focused
          />
        )}
      </div>
    </div>
  );
}

const glyph = (kind: PoppedPane["kind"]): string =>
  kind === "claude" ? "✳" : kind === "git" ? "⎇"
    : kind === "editor" ? "◧" : kind === "agents" ? "◉"
      : kind === "config" ? "⚙" : "❯";

const S: Record<string, React.CSSProperties> = {
  shell: {
    display: "flex", flexDirection: "column", height: "100vh",
    background: C.bg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden",
  },
  bar: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 10px 6px 78px", // clear of the traffic lights
    background: C.chrome, borderBottom: `1px solid ${C.line}`,
    // Lets the whole bar drag the window.
    WebkitAppRegion: "drag",
  } as React.CSSProperties,
  body: { flex: 1, minHeight: 0, position: "relative" },
  empty: {
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100vh", background: C.bg, color: C.faint,
    fontFamily: "system-ui", fontSize: 12,
  },
};
