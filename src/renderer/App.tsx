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
import {
  closePane, isValid, leaf, newId, paneIds, split, type Dir, type Node,
} from "../shared/layout.js";

type PaneKind = "shell" | "claude" | "git";

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

  return (
    <div style={S.app}>
      <div style={S.tabbar}>
        <div style={S.dragRegion} />
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTabId(t.id)}
            style={{ ...S.tab, ...(t.id === activeTabId ? S.tabActive : null) }}
          >
            {t.name}
          </button>
        ))}
        <button onClick={addTab} style={S.tabAdd} title="New tab (⌘T)">+</button>
        <div style={S.spacer} />
        <span style={S.hint}>⌘D split · ⌘⇧D down · ⌘↵ claude · ⌘G git · ⌘W close</span>
      </div>

      <div style={S.body}>
        <Workspace
          tree={active.tree}
          focusedPaneId={active.focusedPaneId}
          onFocusPane={(paneId) => updateTab(active.id, (t) => ({ ...t, focusedPaneId: paneId }))}
          onTreeChange={(tree) => updateTab(active.id, (t) => ({ ...t, tree }))}
          renderPane={(paneId, focused) => {
            const spec = active.panes[paneId];
            if (!spec) return null;
            if (spec.kind === "git") {
              return <GitStatusPane cwd={spec.cwd ?? cwdOf(active)} />;
            }
            return (
              <TerminalPane
                paneId={paneId}
                focused={focused}
                cwd={spec.cwd}
                cmd={spec.kind === "claude" ? "claude" : undefined}
                args={spec.kind === "claude" ? [] : undefined}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  app: { display: "flex", flexDirection: "column", height: "100vh", background: "#101014", color: "#d8d8dc" },
  boot: { padding: 20, fontFamily: "system-ui", color: "#6b6b72" },
  tabbar: {
    display: "flex", alignItems: "center", gap: 4, padding: "6px 10px 6px 84px",
    background: "#16161c", borderBottom: "1px solid #24242c",
    fontFamily: "system-ui", fontSize: 12,
    // @ts-expect-error Electron-specific CSS property
    WebkitAppRegion: "drag",
  },
  dragRegion: { flex: "0 0 0" },
  tab: {
    padding: "3px 12px", borderRadius: 5, border: "1px solid transparent",
    background: "transparent", color: "#8a8a93", cursor: "pointer", fontSize: 12,
    // @ts-expect-error Electron-specific CSS property
    WebkitAppRegion: "no-drag",
  },
  tabActive: { background: "#24242c", color: "#e6e6ea", border: "1px solid #2f6feb" },
  tabAdd: {
    padding: "3px 9px", borderRadius: 5, border: "none", background: "transparent",
    color: "#6b6b72", cursor: "pointer", fontSize: 14,
    // @ts-expect-error Electron-specific CSS property
    WebkitAppRegion: "no-drag",
  },
  spacer: { flex: 1 },
  hint: { color: "#4a4a52", fontSize: 11 },
  body: { flex: 1, minHeight: 0, padding: 6 },
};
