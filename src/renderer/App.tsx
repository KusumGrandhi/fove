/**
 * App shell: tabs of workspaces, each a split tree of panes.
 *
 * A pane is a generic container -- today every pane kind is a terminal (a
 * shell, or `claude`), but the registry is what later lets a pane be a diff, a
 * git tree, or an editor without touching the layout code.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Workspace } from "./layout/Workspace.js";
import { TerminalPane } from "./panes/Terminal.js";
import { GitStatusPane } from "./panes/GitStatus.js";
import { EditorPane } from "./panes/Editor.js";
import { C, Divider, ToolButton } from "./ui/Chrome.js";
import {
  closePane, isValid, leaf, newId, paneIds, split, type Dir, type Node,
} from "../shared/layout.js";

type PaneKind = "shell" | "claude" | "git" | "editor";

interface PaneSpec {
  id: string;
  kind: PaneKind;
  title: string;
  cwd?: string;
}

interface Tab {
  id: string;
  name: string;
  tree: Node;
  panes: Record<string, PaneSpec>;
  focusedPaneId: string;
}

interface Persisted {
  tabs: Tab[];
  activeTabId: string;
}

const makePane = (kind: PaneKind, cwd?: string): PaneSpec => ({
  id: newId("p"),
  kind,
  title: kind,
  cwd,
});

function newTab(name: string, kind: PaneKind = "shell"): Tab {
  const pane = makePane(kind);
  return {
    id: newId("t"),
    name,
    tree: leaf(pane.id),
    panes: { [pane.id]: pane },
    focusedPaneId: pane.id,
  };
}

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const restored = useRef(false);

  // ---- restore / persist ---------------------------------------------------
  useEffect(() => {
    void (async () => {
      const saved = (await window.th.loadLayout()) as Persisted | null;
      // A corrupt or stale layout must never leave the user with a blank app.
      const usable =
        saved &&
        Array.isArray(saved.tabs) &&
        saved.tabs.length > 0 &&
        saved.tabs.every((t) => t.tree && isValid(t.tree));
      if (usable) {
        setTabs(saved!.tabs);
        setActiveTabId(
          saved!.tabs.some((t) => t.id === saved!.activeTabId)
            ? saved!.activeTabId
            : saved!.tabs[0]!.id,
        );
      } else {
        const t = newTab("1");
        setTabs([t]);
        setActiveTabId(t.id);
      }
      restored.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!restored.current || tabs.length === 0) return;
    window.th.saveLayout({ tabs, activeTabId } satisfies Persisted);
  }, [tabs, activeTabId]);

  const active = tabs.find((t) => t.id === activeTabId);

  const updateTab = useCallback((id: string, fn: (t: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  // ---- pane actions --------------------------------------------------------
  const doSplit = useCallback(
    (dir: Dir, kind: PaneKind = "shell") => {
      if (!active) return;
      const pane = makePane(kind, active.panes[active.focusedPaneId]?.cwd);
      updateTab(active.id, (t) => ({
        ...t,
        tree: split(t.tree, t.focusedPaneId, pane.id, dir),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
      }));
    },
    [active, updateTab],
  );

  const doClosePane = useCallback(() => {
    if (!active) return;
    const target = active.focusedPaneId;
    const next = closePane(active.tree, target);
    window.th.kill(target);
    if (next === null) {
      // Last pane in the tab: close the tab too.
      setTabs((prev) => {
        const rest = prev.filter((t) => t.id !== active.id);
        if (rest.length === 0) {
          const t = newTab("1");
          setActiveTabId(t.id);
          return [t];
        }
        if (active.id === activeTabId) setActiveTabId(rest[0]!.id);
        return rest;
      });
      return;
    }
    updateTab(active.id, (t) => {
      const { [target]: _gone, ...panes } = t.panes;
      const remaining = paneIds(next);
      return {
        ...t,
        tree: next,
        panes,
        focusedPaneId: remaining.includes(t.focusedPaneId) ? t.focusedPaneId : remaining[0]!,
      };
    });
  }, [active, activeTabId, updateTab]);

  const addTab = useCallback(() => {
    setTabs((prev) => {
      const t = newTab(String(prev.length + 1));
      setActiveTabId(t.id);
      return [...prev, t];
    });
  }, []);

  // ---- keybindings ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Splits mirror the muscle memory of iTerm/tmux.
      if (e.key === "d" && !e.shiftKey) { e.preventDefault(); doSplit("row"); }
      else if (e.key === "D" || (e.key === "d" && e.shiftKey)) { e.preventDefault(); doSplit("column"); }
      else if (e.key === "w") { e.preventDefault(); doClosePane(); }
      else if (e.key === "t") { e.preventDefault(); addTab(); }
      else if (e.key === "j") { e.preventDefault(); doSplit("column", "claude"); }
      else if (e.key === "g") { e.preventDefault(); doSplit("row", "git"); }
      else if (e.key === "e") { e.preventDefault(); doSplit("row", "editor"); }
      else if (e.key === "Enter") { e.preventDefault(); doSplit("row", "claude"); }
      else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (tabs[i]) { e.preventDefault(); setActiveTabId(tabs[i]!.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSplit, doClosePane, addTab, tabs]);

  // Panes inherit the tab's directory; the git pane needs one to look at.
  const cwdOf = (tab: Tab): string =>
    tab.panes[tab.focusedPaneId]?.cwd ?? Object.values(tab.panes)[0]?.cwd ?? ".";

  if (!active) return <div style={S.boot}>starting…</div>;

  const paneCount = Object.keys(active.panes).length;

  return (
    <div style={S.app}>
      {/* --- title bar: window controls area + tabs --- */}
      <div style={S.titlebar}>
        <div style={S.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTabId(t.id)}
              style={{ ...S.tab, ...(t.id === activeTabId ? S.tabActive : null) }}
              title={`Tab ${t.name}`}
            >
              {t.name}
            </button>
          ))}
          <button onClick={addTab} style={S.tabAdd} title="New tab (⌘T)">+</button>
        </div>
        <div style={S.grow} />
        <span style={S.appName}>terminal-helper</span>
      </div>

      {/* --- toolbar: every shortcut, clickable --- */}
      <div style={S.toolbar}>
        <ToolButton label="Split" hint="⌘D" icon="▊▊" onClick={() => doSplit("row")} />
        <ToolButton label="Split down" hint="⌘⇧D" icon="▤" onClick={() => doSplit("column")} />
        <Divider />
        <ToolButton label="Claude" hint="⌘↵" icon="✳" onClick={() => doSplit("row", "claude")} />
        <ToolButton label="Shell" icon="❯" onClick={() => doSplit("row", "shell")} />
        <ToolButton label="Git" hint="⌘G" icon="⎇" onClick={() => doSplit("row", "git")} />
        <ToolButton label="Editor" hint="⌘E" icon="◧" onClick={() => doSplit("row", "editor")} />
        <Divider />
        <ToolButton label="New tab" hint="⌘T" icon="＋" onClick={addTab} />
        <div style={S.grow} />
        <ToolButton
          label="Close pane"
          hint="⌘W"
          icon="✕"
          danger
          onClick={doClosePane}
          disabled={paneCount <= 1 && tabs.length <= 1}
        />
      </div>

      {/* --- the panes live inside this frame, beside the stats rail --- */}
      <div style={S.stage}>
        <div style={S.workspace}>
          <Workspace
            tree={active.tree}
            focusedPaneId={active.focusedPaneId}
            onFocusPane={(paneId) => updateTab(active.id, (t) => ({ ...t, focusedPaneId: paneId }))}
            onTreeChange={(tree) => updateTab(active.id, (t) => ({ ...t, tree }))}
            renderPane={(paneId, focused, dragHandle) => {
              const spec = active.panes[paneId];
              if (!spec) return null;
              return (
                <div style={S.paneBox}>
                  <div
                    {...dragHandle}
                    style={{
                      ...S.paneHeader,
                      ...(focused ? S.paneHeaderActive : null),
                      cursor: "grab",
                    }}
                    title="Drag to move this pane"
                  >
                    <span style={S.gripDots}>⠿</span>
                    <span style={{ color: focused ? C.fg : C.faint }}>
                      {spec.kind === "claude" ? "✳ claude"
                        : spec.kind === "git" ? "⎇ git"
                        : spec.kind === "editor" ? "◧ editor"
                        : "❯ shell"}
                    </span>
                    <div style={S.grow} />
                    <button
                      style={S.paneClose}
                      title="Close this pane"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateTab(active.id, (t) => ({ ...t, focusedPaneId: paneId }));
                        setTimeout(doClosePane, 0);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div style={S.paneBody}>
                    {spec.kind === "git" ? (
                      <GitStatusPane cwd={spec.cwd ?? cwdOf(active)} />
                    ) : spec.kind === "editor" ? (
                      <EditorPane cwd={spec.cwd ?? cwdOf(active)} />
                    ) : (
                      <TerminalPane
                        paneId={paneId}
                        focused={focused}
                        cwd={spec.cwd}
                        cmd={spec.kind === "claude" ? "claude" : undefined}
                        args={spec.kind === "claude" ? [] : undefined}
                      />
                    )}
                  </div>
                </div>
              );
            }}
          />
        </div>

        {/* Stats rail: permanent, intentionally empty. Widgets land here. */}
        <aside style={S.rail}>
          <div style={S.railHeader}>STATS</div>
          <div style={S.railBody}>
            <div style={S.railPlaceholder}>widgets go here</div>
          </div>
        </aside>
      </div>

      {/* --- status bar --- */}
      <div style={S.statusbar}>
        <span>{paneCount} pane{paneCount === 1 ? "" : "s"}</span>
        <Divider />
        <span>tab {active.name} of {tabs.length}</span>
        <div style={S.grow} />
        <span style={{ color: C.faint }}>drag a divider to resize</span>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  app: {
    display: "flex", flexDirection: "column", height: "100vh",
    background: C.bg, color: C.fg, fontFamily: "system-ui", fontSize: 12,
    overflow: "hidden",
  },
  boot: { padding: 20, fontFamily: "system-ui", color: C.faint },
  grow: { flex: 1 },

  // Title bar. Left padding clears the macOS traffic lights.
  titlebar: {
    display: "flex", alignItems: "center", gap: 8,
    height: 38, padding: "0 12px 0 82px",
    background: C.chrome, borderBottom: `1px solid ${C.line}`,
    flexShrink: 0,
    WebkitAppRegion: "drag",
  } as React.CSSProperties,
  appName: { color: C.faint, fontSize: 11, letterSpacing: 0.3 },
  tabs: { display: "flex", alignItems: "center", gap: 3 },
  tab: {
    padding: "4px 14px", borderRadius: 6, border: "1px solid transparent",
    background: "transparent", color: C.faint, cursor: "pointer", fontSize: 12,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  tabActive: { background: C.chromeHi, color: C.fg, border: `1px solid ${C.accent}` },
  tabAdd: {
    padding: "3px 10px", borderRadius: 6, border: "none", background: "transparent",
    color: C.faint, cursor: "pointer", fontSize: 15, lineHeight: "16px",
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,

  // Toolbar: every shortcut as a button.
  toolbar: {
    display: "flex", alignItems: "center", gap: 2,
    padding: "5px 10px", background: C.chrome,
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },

  // The stage insets the panes so they read as content inside the app.
  stage: { flex: 1, minHeight: 0, padding: 10, display: "flex" },
  workspace: {
    flex: 1, minWidth: 0, minHeight: 0,
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
    padding: 6, overflow: "hidden",
  },

  // Each pane gets a titled frame.
  paneBox: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  paneHeader: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "3px 8px", background: "#14141a",
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
    fontSize: 11, color: C.faint,
  },
  paneHeaderActive: { background: "#1a2333", borderBottom: `1px solid ${C.accent}` },
  paneClose: {
    background: "transparent", border: "none", color: C.faint,
    cursor: "pointer", fontSize: 11, padding: "0 3px", lineHeight: 1,
  },
  paneBody: { flex: 1, minHeight: 0, overflow: "hidden" },

  rail: {
    width: 260, flexShrink: 0, marginLeft: 10,
    display: "flex", flexDirection: "column",
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
    overflow: "hidden",
  },
  railHeader: {
    padding: "7px 11px", fontSize: 10, letterSpacing: 0.6, color: C.faint,
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  railBody: { flex: 1, minHeight: 0, overflowY: "auto", padding: 10 },
  railPlaceholder: {
    height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
    color: "#33333c", fontSize: 11, border: `1px dashed ${C.line}`, borderRadius: 8,
  },
  gripDots: { color: C.faint, fontSize: 12, lineHeight: 1, marginRight: 2 },

  statusbar: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "4px 12px", background: C.chrome,
    borderTop: `1px solid ${C.line}`, color: C.dim, fontSize: 11, flexShrink: 0,
  },
};
