/**
 * App shell: tabs of workspaces, each a split tree of panes.
 *
 * A pane is a generic container -- today every pane kind is a terminal (a
 * shell, or `claude`), but the registry is what later lets a pane be a diff, a
 * git tree, or an editor without touching the layout code.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Workspace } from "./layout/Workspace.js";
import { TerminalPane } from "./panes/Terminal.js";
import { GitStatusPane } from "./panes/GitStatus.js";
import { EditorPane } from "./panes/Editor.js";
import { AgentsPane } from "./panes/Agents.js";
import { DiffView, type DiffRequest } from "./panes/DiffView.js";
import { AgentsWidget, SkillsWidget, TokensWidget, useSnapshot } from "./ui/widgets.js";
import { TeammateBar, TeammateView, useTeammates } from "./ui/Teammates.js";
import { C, Divider, ToolButton } from "./ui/Chrome.js";
import { close as closeTab, insert as insertTab, setPinned } from "../shared/tabs.js";
import {
  closePane, closePaneChecked, isValid, leaf, newId, paneIds, prunePins, setPanePinned,
  split, type Dir, type Node, type Pins,
} from "../shared/layout.js";

type PaneKind = "shell" | "claude" | "git" | "editor" | "agents";

interface PaneSpec {
  id: string;
  kind: PaneKind;
  title: string;
  cwd?: string;
  /** For editor panes: the file to show, e.g. one Claude asked us to open. */
  openPath?: string;
}

/**
 * A tab is a workspace: one directory, with panes arranged inside it.
 *
 * That directory is usually a git worktree, which is why "tab per worktree" and
 * "tab per project" are the same feature -- a worktree is just another
 * directory on disk. Every pane in a tab inherits the tab's cwd, so a shell, a
 * git view and an agent tree in one tab are all looking at the same checkout.
 */
interface Tab {
  id: string;
  name: string;
  /** The workspace directory. Every pane inside uses it. */
  cwd: string;
  /** Branch name when the directory is a git worktree, for the tab label. */
  branch?: string;
  /** Pinned tabs hold the front of the bar and keep their exact position. */
  pinned?: boolean;
  /**
   * Panes that refuse to be moved, displaced or closed. Stored as an array
   * rather than a Set because the whole tab is JSON-persisted, and a Set
   * round-trips to `{}`.
   */
  pinnedPanes?: string[];
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

function newTab(cwd: string, kind: PaneKind = "shell", branch?: string): Tab {
  const pane = makePane(kind, cwd);
  return {
    id: newId("t"),
    name: cwd.split("/").filter(Boolean).pop() ?? cwd,
    cwd,
    branch,
    tree: leaf(pane.id),
    panes: { [pane.id]: pane },
    focusedPaneId: pane.id,
  };
}

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const restored = useRef(false);
  /** The directory panes default to: where the app was launched. */
  const [appCwd, setAppCwd] = useState<string>("");

  // ---- restore / persist ---------------------------------------------------
  useEffect(() => {
    void (async () => {
      const saved = (await window.th.loadLayout()) as Persisted | null;
      // A corrupt or stale layout must never leave the user with a blank app.
      const cwd = await window.th.appCwd();
      setAppCwd(cwd);
      const usable =
        saved &&
        Array.isArray(saved.tabs) &&
        saved.tabs.length > 0 &&
        saved.tabs.every((t) => t.tree && isValid(t.tree));
      if (usable) {
        // Tabs saved before workspaces had no cwd; adopt the launch directory.
        setTabs(saved!.tabs.map((t) => ({
          ...t,
          cwd: t.cwd || cwd,
          name: t.name || cwd.split("/").pop()!,
          // A pin for a pane that no longer exists would be invisible and
          // impossible to clear from the UI.
          pinnedPanes: [...prunePins(new Set(t.pinnedPanes ?? []), t.tree)],
        })));
        setActiveTabId(
          saved!.tabs.some((t) => t.id === saved!.activeTabId)
            ? saved!.activeTabId
            : saved!.tabs[0]!.id,
        );
      } else {
        // First run: one workspace, the folder the app was launched from.
        const t = newTab(cwd);
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

  /** Pinned panes of the active tab, as the Set the layout engine expects. */
  const panePins: Pins = useMemo(
    () => new Set(active?.pinnedPanes ?? []),
    [active?.pinnedPanes],
  );

  /** Pin or unpin one pane. */
  const togglePanePin = useCallback(
    (paneId: string) => {
      if (!active) return;
      updateTab(active.id, (t) => {
        const pins = new Set(t.pinnedPanes ?? []);
        const next = setPanePinned(pins, paneId, !pins.has(paneId));
        return { ...t, pinnedPanes: [...next] };
      });
    },
    [active, updateTab],
  );

  // ---- pane actions --------------------------------------------------------
  const doSplit = useCallback(
    (dir: Dir, kind: PaneKind = "shell") => {
      if (!active) return;
      const pane = makePane(kind, active.cwd);
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
    // A pinned pane declines to close. Unpin it first -- that is the whole point.
    if ((active.pinnedPanes ?? []).includes(target)) return;
    const next = closePane(active.tree, target);
    window.th.kill(target);
    if (next === null) {
      // Last pane in the tab: close the tab too.
      setTabs((prev) => {
        const rest = closeTab(prev, active.id);
        if (rest.length === 0) {
          const t = newTab(active.cwd || appCwd);
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
      const pins = [...prunePins(new Set(t.pinnedPanes ?? []), next)];
      return {
        ...t,
        tree: next,
        panes,
        pinnedPanes: pins,
        focusedPaneId: remaining.includes(t.focusedPaneId) ? t.focusedPaneId : remaining[0]!,
      };
    });
  }, [active, activeTabId, updateTab]);

  /** Open a directory as a new workspace. Falls back to the current one. */
  const addTab = useCallback(
    async (cwd?: string, branch?: string) => {
      const dir = cwd ?? (await window.th.pickFolder());
      if (!dir) return;
      const t = newTab(dir, "shell", branch);
      setTabs((prev) => insertTab(prev, t));
      setActiveTabId(t.id);
    },
    [],
  );

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => {
      const t = prev.find((x) => x.id === id);
      return t ? setPinned(prev, id, !t.pinned) : prev;
    });
  }, []);

  /** Worktrees of the active workspace, offered as one-click new tabs. */
  const [worktrees, setWorktrees] = useState<{ path: string; branch?: string }[]>([]);
  useEffect(() => {
    if (!active?.cwd) return;
    void (async () => {
      const w = (await window.th.gitWorktrees(active.cwd)) as { path: string; branch?: string }[];
      setWorktrees(w ?? []);
    })();
  }, [active?.cwd]);

  // ---- keybindings ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Splits mirror the muscle memory of iTerm/tmux.
      if (e.key === "d" && !e.shiftKey) { e.preventDefault(); doSplit("row"); }
      else if (e.key === "D" || (e.key === "d" && e.shiftKey)) { e.preventDefault(); doSplit("column"); }
      else if (e.key === "w") { e.preventDefault(); doClosePane(); }
      else if (e.key === "t") { e.preventDefault(); void addTab(); }
      else if (e.key === "j") { e.preventDefault(); doSplit("column", "claude"); }
      else if (e.key === "g") { e.preventDefault(); doSplit("row", "git"); }
      else if (e.key === "e") { e.preventDefault(); doSplit("row", "editor"); }
      else if (e.key === "r") { e.preventDefault(); doSplit("row", "agents"); }
      else if (e.key === "p" && e.shiftKey) { e.preventDefault(); togglePin(activeTabId); }
      else if (e.key === "p") { e.preventDefault(); if (active) togglePanePin(active.focusedPaneId); }
      else if (e.key === "Enter") { e.preventDefault(); doSplit("row", "claude"); }
      else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (tabs[i]) { e.preventDefault(); setActiveTabId(tabs[i]!.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSplit, doClosePane, addTab, tabs, togglePin, activeTabId, active, togglePanePin]);

  // The rail watches whatever directory the active tab is pointed at. The hook
  // runs unconditionally -- before the `!active` early return -- because hooks
  // cannot be called conditionally.
  // The rail follows the active workspace.
  const railCwd = active?.cwd || appCwd;
  const snap = useSnapshot(railCwd, 2500);

  /**
   * Diffs Claude is blocked on, oldest first. A turn can produce several, and
   * each must get its own verdict, so they queue rather than overwrite.
   */
  const [diffs, setDiffs] = useState<DiffRequest[]>([]);
  useEffect(() => {
    const off = window.th.onIdeOpenDiff((raw) => {
      const d = raw as DiffRequest;
      if (d?.id) setDiffs((prev) => [...prev, d]);
    });
    return off;
  }, []);

  const answerDiff = useCallback((id: string, verdict: "saved" | "rejected") => {
    window.th.ideDiffResult(id, verdict);
    setDiffs((prev) => prev.filter((d) => d.id !== id));
  }, []);

  /**
   * Claude Code asked this app to open a file (it discovered us as its IDE).
   *
   * Reuse an editor pane if the tab has one -- opening a new pane per file
   * would shred the layout during a busy turn -- otherwise split one off the
   * focused pane.
   */
  useEffect(() => {
    const off = window.th.onIdeOpenFile((raw) => {
      const req = raw as { filePath?: string };
      const file = req?.filePath;
      if (!file || !active) return;
      const existing = Object.values(active.panes).find((p) => p.kind === "editor");
      if (existing) {
        updateTab(active.id, (t) => ({
          ...t,
          panes: { ...t.panes, [existing.id]: { ...existing, openPath: file } },
          focusedPaneId: existing.id,
        }));
        return;
      }
      const pane = { ...makePane("editor", active.cwd), openPath: file };
      updateTab(active.id, (t) => ({
        ...t,
        tree: split(t.tree, t.focusedPaneId, pane.id, "row"),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
      }));
    });
    return off;
  }, [active, updateTab]);

  // Tell the main process which workspaces and editors are open, so the IDE
  // server can answer getWorkspaceFolders / getOpenEditors truthfully.
  useEffect(() => {
    const editors = tabs.flatMap((t) =>
      Object.values(t.panes)
        .filter((p) => p.kind === "editor" && p.openPath)
        .map((p) => ({ filePath: p.openPath! })),
    );
    window.th.ideEditors(editors);
  }, [tabs]);

  // Live teammates (a tmux swarm). The bar renders nothing when none run.
  const { team, live } = useTeammates(2500);
  const [openMateId, setOpenMateId] = useState<string | null>(null);
  const openMate = live.find((m) => m.agentId === openMateId) ?? null;
  // A teammate that finishes while open should not leave a dead viewer behind.
  useEffect(() => {
    if (openMateId && !openMate) setOpenMateId(null);
  }, [openMateId, openMate]);

  // Panes inherit the tab's directory; the git pane needs one to look at.
  const cwdOf = (tab: Tab): string => tab.cwd || appCwd;

  if (!active) return <div style={S.boot}>starting…</div>;

  const paneCount = Object.keys(active.panes).length;

  return (
    <div style={S.app}>
      {/* --- title bar: window controls area + tabs --- */}
      <div style={S.titlebar}>
        <div style={S.tabs}>
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveTabId(t.id)}
              onContextMenu={(e) => { e.preventDefault(); togglePin(t.id); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); togglePin(t.id); } }}
              style={{ ...S.tab, ...(t.id === activeTabId ? S.tabActive : null) }}
              title={`${t.cwd}\n${t.pinned ? "Pinned — click the pin to unpin" : "Right-click or click the pin to pin"}`}
            >
              <button
                onClick={(e) => { e.stopPropagation(); togglePin(t.id); }}
                style={{ ...S.pinBtn, color: t.pinned ? C.accent : C.faint }}
                title={t.pinned ? "Unpin this workspace" : "Pin this workspace in place"}
              >
                {t.pinned ? "📌" : "○"}
              </button>
              <span>{t.name}</span>
              {t.branch && <span style={S.tabBranch}>⎇ {t.branch}</span>}
            </div>
          ))}
          <button onClick={() => void addTab()} style={S.tabAdd} title="Open a folder as a new workspace (⌘T)">+</button>
        </div>
        <div style={S.grow} />
        <span style={S.appName}>fove</span>
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
        <ToolButton label="Agents" hint="⌘R" icon="◉" onClick={() => doSplit("row", "agents")} />
        <Divider />
        <ToolButton
          label={active && panePins.has(active.focusedPaneId) ? "Unpin pane" : "Pin pane"}
          hint="⌘P"
          icon={active && panePins.has(active.focusedPaneId) ? "📌" : "⚲"}
          onClick={() => { if (active) togglePanePin(active.focusedPaneId); }}
        />
        <Divider />
        <ToolButton label="Open folder" hint="⌘T" icon="＋" onClick={() => void addTab()} />
        {worktrees.length > 1 && (
          <select
            value=""
            onChange={(e) => {
              const w = worktrees.find((x) => x.path === e.target.value);
              if (w) void addTab(w.path, w.branch);
              e.target.value = "";
            }}
            style={S.wtSelect}
            title="Open a worktree as a new workspace"
          >
            <option value="">⎇ worktree…</option>
            {worktrees
              .filter((w) => w.path !== active.cwd)
              .map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch ?? w.path.split("/").pop()}
                </option>
              ))}
          </select>
        )}
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

      {/* --- teammate sub-tabs: present only while a swarm is running --- */}
      <TeammateBar live={live} openId={openMateId} onOpen={setOpenMateId} />
      {openMate && team?.socket && (
        <TeammateView socket={team.socket} mate={openMate} onClose={() => setOpenMateId(null)} />
      )}

      {/* A diff Claude is blocked on. One at a time; the rest wait behind it. */}
      {diffs[0] && <DiffView req={diffs[0]} onVerdict={answerDiff} />}

      {/* --- the panes live inside this frame, beside the stats rail --- */}
      <div style={S.stage}>
        <div style={S.workspace}>
          <Workspace
            tree={active.tree}
            pins={panePins}
            focusedPaneId={active.focusedPaneId}
            onFocusPane={(paneId) => updateTab(active.id, (t) => ({ ...t, focusedPaneId: paneId }))}
            onTreeChange={(tree) => updateTab(active.id, (t) => ({ ...t, tree }))}
            renderPane={(paneId, focused, dragHandle) => {
              const spec = active.panes[paneId];
              if (!spec) return null;
              const isPin = panePins.has(paneId);
              return (
                <div style={S.paneBox}>
                  <div
                    {...dragHandle}
                    style={{
                      ...S.paneHeader,
                      ...(focused ? S.paneHeaderActive : null),
                      cursor: isPin ? "default" : "grab",
                    }}
                    title={isPin ? "Pinned: this pane stays put" : "Drag to move this pane"}
                  >
                    <span style={{ ...S.gripDots, opacity: isPin ? 0.25 : 1 }}>⠿</span>
                    <span style={{ color: focused ? C.fg : C.faint }}>
                      {spec.kind === "claude" ? "✳ claude"
                        : spec.kind === "git" ? "⎇ git"
                        : spec.kind === "editor" ? "◧ editor"
                        : spec.kind === "agents" ? "◉ agents"
                        : "❯ shell"}
                    </span>
                    <div style={S.grow} />
                    <button
                      style={{ ...S.paneClose, color: isPin ? C.accent : undefined }}
                      title={isPin ? "Unpin this pane" : "Pin this pane in place"}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePanePin(paneId);
                      }}
                    >
                      {isPin ? "📌" : "⚲"}
                    </button>
                    <button
                      style={{ ...S.paneClose, opacity: isPin ? 0.3 : 1 }}
                      disabled={isPin}
                      title={isPin ? "Pinned panes can't be closed -- unpin first" : "Close this pane"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPin) return;
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
                      <EditorPane
                        key={spec.id}
                        cwd={spec.cwd ?? cwdOf(active)}
                        initialPath={spec.openPath}
                      />
                    ) : spec.kind === "agents" ? (
                      <AgentsPane cwd={spec.cwd ?? cwdOf(active)} />
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
            <TokensWidget snap={snap} />
            <AgentsWidget snap={snap} />
            <SkillsWidget />
          </div>
        </aside>
      </div>

      {/* --- status bar --- */}
      <div style={S.statusbar}>
        <span>{paneCount} pane{paneCount === 1 ? "" : "s"}</span>
        <Divider />
        <span title={active.cwd}>
          {active.name}{active.branch ? ` · ⎇ ${active.branch}` : ""}
        </span>
        <Divider />
        <span style={{ color: C.faint }}>{tabs.length} workspace{tabs.length === 1 ? "" : "s"}</span>
        <div style={S.grow} />
        <span style={{ color: C.faint }}>⌘⇧P pins a workspace</span>
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
    display: "flex", alignItems: "center",
    padding: "4px 12px", borderRadius: 6, border: "1px solid transparent",
    background: "transparent", color: C.faint, cursor: "pointer", fontSize: 12,
    userSelect: "none",
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  tabActive: { background: C.chromeHi, color: C.fg, border: `1px solid ${C.accent}` },
  tabBranch: { color: C.faint, fontSize: 10, marginLeft: 6 },
  pinBtn: {
    background: "transparent", border: "none", padding: 0, marginRight: 5,
    cursor: "pointer", fontSize: 9, lineHeight: 1,
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  wtSelect: {
    background: "transparent", color: C.dim, border: `1px solid ${C.line}`,
    borderRadius: 6, padding: "3px 6px", fontSize: 11, cursor: "pointer",
    fontFamily: "system-ui",
  },
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
