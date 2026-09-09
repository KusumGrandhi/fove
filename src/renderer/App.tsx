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
import { ConfigPane } from "./panes/Config.js";
import { SearchPane } from "./panes/Search.js";
import { BrowserPane } from "./panes/Browser.js";
import { DebuggerPane } from "./panes/Debugger.js";
import { DiffView, type DiffRequest } from "./panes/DiffView.js";
import { ModelPicker, type Provider } from "./ui/ModelPicker.js";
import { AgentsWidget, TokensWidget, useSnapshot } from "./ui/widgets.js";
import { TeammateBar, TeammateView, useTeammates } from "./ui/Teammates.js";
import { C, Divider, LayoutMenu, ToolButton } from "./ui/Chrome.js";
import { Palette, type PaletteItem } from "./ui/Palette.js";
import { Keel, type TurnReview } from "./ui/Keel.js";
import { KeelWorkspace, type WorklistWire, type CardWire } from "./ui/KeelWorkspace.js";
import { KeelIntents, type IntentsWire } from "./ui/KeelIntents.js";
import { initial as initialHandoff, type HandoffState } from "../shared/handoff.js";
import type { WorktreeStatus } from "../main/worktrees.js";
import { THEMES, DEFAULT_THEME, applyTheme } from "./ui/themes.js";
import {
  close as closeTab, insert as insertTab, noteEditorPath as applyEditorPath, setPinned,
} from "../shared/tabs.js";
import {
  closePane, closePaneChecked, isValid, leaf, newId, paneIds, prunePins, setPanePinned,
  split, type Dir, type Node, type Pins,
} from "../shared/layout.js";
import {
  PRESETS, DEFAULT_PRESET, presetById, planPresetApply, type LayoutPreset,
} from "../shared/layouts.js";

type PaneKind = "shell" | "claude" | "git" | "editor" | "agents" | "config" | "search" | "browser" | "debug";

interface PaneSpec {
  id: string;
  kind: PaneKind;
  title: string;
  cwd?: string;
  /** For editor panes: the file to show, e.g. one Claude asked us to open. */
  openPath?: string;
  /** Line to reveal, when the request came from a diff or a stack frame. */
  openLine?: number;
  /** Changes on every request, so reopening the same path still fires. */
  openNonce?: number;
  /** For claude panes routed at a non-default backend. */
  providerEnv?: Record<string, string>;
  providerLabel?: string;
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

/**
 * A new workspace, arranged by a starting layout.
 *
 * `preset` is what a workspace begins as, not what it is: the tree is a normal
 * tree the moment it exists, and nothing downstream knows which preset made
 * it. Passing no preset gives a single pane, which is what the callers that
 * genuinely want one pane (a recovery tab) still need.
 */
function newTab(
  cwd: string,
  kind: PaneKind = "shell",
  branch?: string,
  preset?: LayoutPreset,
): Tab {
  const base = {
    id: newId("t"),
    name: cwd.split("/").filter(Boolean).pop() ?? cwd,
    cwd,
    branch,
  };

  if (!preset) {
    const pane = makePane(kind, cwd);
    return { ...base, tree: leaf(pane.id), panes: { [pane.id]: pane }, focusedPaneId: pane.id };
  }

  const specs = preset.panes.map((k) => makePane(k, cwd));
  const ids = specs.map((p) => p.id);
  return {
    ...base,
    tree: preset.build(ids),
    panes: Object.fromEntries(specs.map((p) => [p.id, p])),
    focusedPaneId: ids[preset.focus] ?? ids[0]!,
  };
}

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const restored = useRef(false);
  /** The directory panes default to: where the app was launched. */
  const [appCwd, setAppCwd] = useState<string>("");
  /**
   * The layout a new workspace starts in.
   *
   * Sticky across tabs on purpose: someone who works in Dev wants the next
   * workspace in Dev too, and re-picking it every time would be the same
   * papercut this feature exists to remove.
   */
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET);
  /** Shown when a workspace is created with no layout decided yet. */
  const [pickingLayout, setPickingLayout] = useState<string | null>(null);

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
        // First run: the folder the app was launched from, in the default
        // layout -- a lone shell was never a useful place to start.
        const t = newTab(cwd, "shell", undefined, presetById(DEFAULT_PRESET));
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
      const t = newTab(dir, "shell", branch, presetById(preset));
      setTabs((prev) => insertTab(prev, t));
      setActiveTabId(t.id);
    },
    [preset],
  );

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => {
      const t = prev.find((x) => x.id === id);
      return t ? setPinned(prev, id, !t.pinned) : prev;
    });
  }, []);

  /**
   * Worktrees of the active workspace, with live status.
   *
   * Refreshed whenever the palette opens rather than on a timer: the dirty
   * count and the agent count are only interesting at the moment you are
   * choosing where to go, and polling `git status` across five worktrees for a
   * list nobody is looking at is work for nothing.
   */
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const loadWorktrees = useCallback(async (cwd: string) => {
    const w = (await window.th.wtList(cwd)) as WorktreeStatus[];
    setWorktrees(w ?? []);
  }, []);
  useEffect(() => {
    if (active?.cwd) void loadWorktrees(active.cwd);
  }, [active?.cwd, loadWorktrees]);

  // ---- keybindings ---------------------------------------------------------
  /**
   * The palette opener, reached through a ref.
   *
   * `openPalette` is declared further down (it needs the worktree loader), and
   * a keybinding closure cannot capture a `const` that is not initialised yet.
   * A ref sidesteps the ordering without moving unrelated code around, and
   * keeps the handler out of the effect's dependency list -- the same shape the
   * search pane's debounce needed.
   */
  const openKeelRef = useRef<() => void>(() => {});
  const openPaletteRef = useRef<() => void>(() => {});

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
      else if (e.key === "m") { e.preventDefault(); setPickerOpen(true); }
      else if (e.key === "k") { e.preventDefault(); doSplit("row", "config"); }
      else if (e.key === "b") { e.preventDefault(); doSplit("row", "browser"); }
      else if (e.key === "f" && e.shiftKey) { e.preventDefault(); doSplit("row", "search"); }
      else if (e.key === "l") { e.preventDefault(); openKeelRef.current(); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); openPaletteRef.current(); }
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

  /**
   * Keel: the review overlay.
   *
   * Held here rather than in a pane because it is an overlay over the whole
   * workspace, and because it must survive whatever the panes are doing --
   * opening it does not unmount anything.
   */
  const [keelOpen, setKeelOpen] = useState(false);
  const [keelReview, setKeelReview] = useState<TurnReview | null>(null);
  const [keelLoading, setKeelLoading] = useState(false);
  /** Which Keel view is showing: the workspace, or the last turn's review. */
  const [keelView, setKeelView] = useState<"workspace" | "turn" | "intents">("workspace");
  const [intents, setIntents] = useState<IntentsWire | null>(null);
  /** Mechanism results from this session only: yesterday's pass is not a pass. */
  const [mechResults, setMechResults] = useState<Record<string, { passed: boolean; output: string }>>({});
  /**
   * The handoff loop, per workspace.
   *
   * Keyed by cwd rather than held for the active tab alone: a loop keeps
   * running when you switch away, and coming back to a finished one is the
   * normal case -- planning takes about a minute.
   */
  const [handoffs, setHandoffs] = useState<Record<string, HandoffState>>({});
  const [worklist, setWorklist] = useState<WorklistWire | null>(null);
  const [cards, setCards] = useState<Record<string, CardWire | undefined>>({});
  /** Open file cards. Capped at two, per rule 4; a third closes the oldest. */
  const [openCards, setOpenCards] = useState<string[]>([]);

  /**
   * Whether the stats rail is collapsed to a spine.
   *
   * Collapsed by default: the rail is a glanceable readout, not something you
   * work in, and 260px of permanent width is a lot to spend on two small cards
   * you look at occasionally. Stored like the theme -- per-machine, and not in
   * the layout file, because it is a display preference rather than part of a
   * workspace.
   */
  const [statsOpen, setStatsOpen] = useState<boolean>(
    () => localStorage.getItem("fove.stats") === "open",
  );
  useEffect(() => {
    localStorage.setItem("fove.stats", statsOpen ? "open" : "closed");
  }, [statsOpen]);

  // The rail watches whatever directory the active tab is pointed at. The hook
  // runs unconditionally -- before the `!active` early return -- because hooks
  // cannot be called conditionally.
  // The rail follows the active workspace.
  const railCwd = active?.cwd || appCwd;
  /**
   * The rail follows the focused claude pane, falling back to any claude pane
   * in the tab. Without this it showed whichever transcript in the folder was
   * touched last -- often an editor's session, not one running in fove.
   */
  const railPaneId = (() => {
    if (!active) return undefined;
    const focused = active.panes[active.focusedPaneId];
    if (focused?.kind === "claude") return focused.id;
    return Object.values(active.panes).find((p) => p.kind === "claude")?.id;
  })();
  // With no claude pane in the tab there is nothing to report. Falling back to
  // the folder's newest transcript is what made the rail show 569.7k for a
  // session running in someone else's editor.
  const hasClaudePane = railPaneId !== undefined;
  // Collapsed means nothing renders the snapshot, so polling for it every
  // 2.5s would be pure waste. An empty cwd is the hook's idle signal.
  const snap = useSnapshot(hasClaudePane && statsOpen ? railCwd : "", 2500, railPaneId);

  /**
   * Diffs Claude is blocked on, oldest first. A turn can produce several, and
   * each must get its own verdict, so they queue rather than overwrite.
   */
  /**
   * The active theme. Stored per-machine in localStorage rather than in the
   * layout file: it is a display preference, not part of a workspace.
   */
  const [themeId, setThemeId] = useState<string>(
    () => localStorage.getItem("fove.theme") ?? DEFAULT_THEME,
  );
  useEffect(() => {
    applyTheme(themeId);
    localStorage.setItem("fove.theme", themeId);
  }, [themeId]);

  /** Panes currently living in their own window. */
  const [popped, setPopped] = useState<Set<string>>(new Set());
  useEffect(() => {
    void (async () => setPopped(new Set((await window.th.popoutList()) as string[])))();
    // A window the user closes puts its pane back rather than leaving a hole.
    const off = window.th.onPopoutClosed((paneId) => {
      setPopped((prev) => {
        if (!prev.has(paneId)) return prev;
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
    });
    return off;
  }, []);

  const togglePopout = useCallback(
    (paneId: string, title: string) => {
      setPopped((prev) => {
        const next = new Set(prev);
        if (next.has(paneId)) {
          next.delete(paneId);
          window.th.popoutClose(paneId);
        } else {
          next.add(paneId);
          window.th.popoutOpen(paneId, title);
        }
        return next;
      });
    },
    [],
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [diffs, setDiffs] = useState<DiffRequest[]>([]);
  useEffect(() => {
    const off = window.th.onIdeOpenDiff((raw) => {
      const d = raw as DiffRequest;
      if (d?.id) setDiffs((prev) => [...prev, d]);
    });
    return off;
  }, []);

  /**
   * Open a claude pane against a chosen backend.
   *
   * ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are read when the client is
   * constructed, so this has to be a *new* pane -- an already-running session
   * cannot be repointed.
   */
  const launchProvider = useCallback(
    (p: Provider, model: string) => {
      if (!active) return;
      const env: Record<string, string> = {};
      if (p.thirdParty) {
        env.ANTHROPIC_BASE_URL = p.baseUrl;
        // The key itself never reaches the renderer: the main process resolves
        // it from the named variable when it spawns the PTY.
        env.FOVE_PROVIDER_TOKEN_ENV = p.authTokenEnv;
        if (model) env.ANTHROPIC_MODEL = model;
      }
      const pane: PaneSpec = {
        ...makePane("claude", active.cwd),
        providerEnv: env,
        providerLabel: p.thirdParty ? `${p.label}${model ? ` · ${model}` : ""}` : undefined,
      };
      updateTab(active.id, (t) => ({
        ...t,
        tree: split(t.tree, t.focusedPaneId, pane.id, "row"),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
      }));
    },
    [active, updateTab],
  );

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
  /** See openPaletteRef: an effect above needs this before it is declared. */
  const openInPaneRef = useRef<(file: string, line?: number) => void>(() => {});

  /**
   * Record which file an editor pane is actually showing.
   *
   * The layout is what a popped-out window reads to rebuild the pane, so it
   * has to follow the editor rather than only the requests made *of* it --
   * opening a file from the editor's own tree is invisible to `openInPane`.
   *
   * `openNonce` is deliberately left alone: bumping it here would feed a
   * reopen back into the pane that just reported the change.
   */
  const noteEditorPath = useCallback(
    (paneId: string, path: string | null) => {
      setTabs((prev) => applyEditorPath(prev, paneId, path));
    },
    [],
  );

  const openInPane = useCallback(
    (file: string, line?: number) => {
      if (!file || !active) return;
      // Reuse an editor pane when the tab has one -- opening a new pane per
      // file would shred the layout during a busy turn.
      const existing = Object.values(active.panes).find((p) => p.kind === "editor");
      // The nonce forces a reopen when the same path is requested twice, which
      // otherwise looks like a dead button.
      const openAt = { openPath: file, openLine: line, openNonce: Date.now() };
      if (existing) {
        updateTab(active.id, (t) => ({
          ...t,
          panes: { ...t.panes, [existing.id]: { ...existing, ...openAt } },
          focusedPaneId: existing.id,
        }));
        return;
      }
      const pane = { ...makePane("editor", active.cwd), ...openAt };
      updateTab(active.id, (t) => ({
        ...t,
        tree: split(t.tree, t.focusedPaneId, pane.id, "row"),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
      }));
    },
    [active, updateTab],
  );
  openInPaneRef.current = openInPane;

  useEffect(() => {
    const off = window.th.onIdeOpenFile((raw) => {
      const req = raw as { filePath?: string };
      if (req?.filePath) openInPane(req.filePath);
    });
    return off;
  }, [openInPane]);

  // ---- command palette -----------------------------------------------------

  /**
   * Rearrange the current workspace into a starting layout.
   *
   * Reuses the panes that are already open wherever the preset asks for the
   * same kind, and this is the whole reason the function is more than four
   * lines: a `claude` pane holds a live session with real scrollback, and a
   * `shell` pane holds a PTY with your history in it. Rebuilding those from
   * scratch to satisfy a layout would throw away work to tidy the furniture.
   *
   * Panes the preset has no place for are closed, and their PTYs killed --
   * leaving them running but unrendered would leak a process per rearrange.
   * Pinned panes are the exception: a pin means "do not move or close this",
   * so a layout change respects it and leaves the tab alone.
   */
  const applyPreset = useCallback(
    (presetId: string) => {
      const p = presetById(presetId);
      if (!p || !active) return;
      setPreset(presetId);

      const pins = new Set(active.pinnedPanes ?? []);
      const open = paneIds(active.tree)
        .map((id) => active.panes[id])
        .filter((spec): spec is PaneSpec => Boolean(spec));

      const plan = planPresetApply(p, open, pins);

      // Fill the preset's slots in order: reused panes where the planner found
      // one, freshly made panes for the rest.
      const fresh = plan.create.map((kind) => makePane(kind as PaneKind, active.cwd));
      const queue = [...plan.keep];
      const freshQueue = [...fresh];
      const slots: PaneSpec[] = p.panes.map((kind) => {
        const reused = queue[0];
        if (reused && reused.kind === kind) return queue.shift() as PaneSpec;
        return freshQueue.shift()!;
      });

      for (const id of plan.kill) window.th.kill(id);

      // Surviving pins the preset had no slot for are split off the last pane,
      // so they keep a real place on screen rather than vanishing.
      let tree = p.build(slots.map((c) => c.id));
      const orphans = plan.extra
        .map((id) => active.panes[id])
        .filter((spec): spec is PaneSpec => Boolean(spec));
      for (const spec of orphans) {
        tree = split(tree, slots[slots.length - 1]!.id, spec.id, "column");
      }

      const all = [...slots, ...orphans];
      updateTab(active.id, (t) => ({
        ...t,
        tree,
        panes: Object.fromEntries(all.map((c) => [c.id, c])),
        pinnedPanes: [...prunePins(pins, tree)],
        focusedPaneId: slots[p.focus]?.id ?? slots[0]!.id,
      }));
    },
    [active, updateTab],
  );

  /**
   * Everything the palette can do: worktrees first, then commands.
   *
   * Worktrees lead because they are the reason the palette exists -- the
   * question "where is my other checkout, and is anything happening in it" had
   * no answer short of opening tabs until now. A worktree already open as a
   * tab switches to it instead of opening a second copy, which is what makes
   * the palette a *switcher* rather than a tab factory.
   */
  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];

    for (const w of worktrees) {
      const open = tabs.find((t) => t.cwd === w.path);
      const badges: { text: string; tone?: string }[] = [];
      // Agents first: "something is running over there" is the fact that most
      // often changes where you want to go.
      if (w.agents > 0) badges.push({ text: `✳ ${w.agents}`, tone: C.accent });
      if (w.dirty === undefined) badges.push({ text: "status unreadable", tone: C.faint });
      else if (w.dirty > 0) badges.push({ text: `● ${w.dirty}`, tone: C.yellow });
      if (w.ahead) badges.push({ text: `↑${w.ahead}`, tone: C.faint });
      if (w.behind) badges.push({ text: `↓${w.behind}`, tone: C.faint });
      if (w.locked) badges.push({ text: "locked", tone: C.faint });
      if (w.prunable) badges.push({ text: "prunable", tone: C.red });

      items.push({
        id: `wt:${w.path}`,
        label: w.branch ?? w.name,
        // The path is searchable but not shown: `.warp/worktrees/core/AGENT`
        // and `conductor/workspaces/core/cape-town` differ only deep in the
        // path, so typing "warp" should find one of them.
        keywords: w.path,
        detail: w.path,
        icon: w.detached ? "⌥" : "⎇",
        badges,
        hint: open ? (open.id === activeTabId ? "current" : "open") : w.name,
        // The active workspace sorts to the top; it is the anchor the rest of
        // the list is read against.
        priority: w.current ? 2 : open ? 1 : 0,
        run: () => {
          if (open) setActiveTabId(open.id);
          else void addTab(w.path, w.branch);
        },
      });
    }

    const cmd = (id: string, label: string, hint: string, run: () => void): PaletteItem =>
      ({ id, label, icon: "›", hint, run });

    // Layouts, above the generic commands: rearranging the workspace is a
    // bigger action than opening one more pane, and worth finding first.
    for (const p of PRESETS) {
      items.push({
        id: `layout:${p.id}`,
        label: `Layout: ${p.label}`,
        icon: "▦",
        hint: p.hint,
        priority: 1,
        run: () => applyPreset(p.id),
      });
    }

    items.push(
      cmd("cmd:keel", "What changed in the last turn", "⌘L", () => openKeelRef.current()),
      cmd("cmd:claude", "New Claude pane", "⌘↵", () => doSplit("row", "claude")),
      cmd("cmd:shell", "New shell pane", "", () => doSplit("row", "shell")),
      cmd("cmd:editor", "New editor pane", "⌘E", () => doSplit("row", "editor")),
      cmd("cmd:git", "New git pane", "⌘G", () => doSplit("row", "git")),
      cmd("cmd:agents", "New agents pane", "⌘R", () => doSplit("row", "agents")),
      cmd("cmd:search", "Search the codebase", "⌘⇧F", () => doSplit("row", "search")),
      cmd("cmd:browser", "New browser pane", "⌘B", () => doSplit("row", "browser")),
      cmd("cmd:debug", "New debugger pane", "", () => doSplit("row", "debug")),
      cmd("cmd:config", "Open config", "⌘K", () => doSplit("row", "config")),
      cmd("cmd:model", "Switch model", "⌘M", () => setPickerOpen(true)),
      cmd("cmd:split", "Split right", "⌘D", () => doSplit("row")),
      cmd("cmd:splitDown", "Split down", "⌘⇧D", () => doSplit("column")),
      cmd("cmd:folder", "Open a folder as a workspace", "⌘T", () => void addTab()),
      cmd("cmd:closePane", "Close pane", "⌘W", doClosePane),
      cmd("cmd:pinTab", "Pin or unpin this workspace", "⌘⇧P", () => togglePin(activeTabId)),
      cmd("cmd:theme", "Next theme", "", () => {
        const i = THEMES.findIndex((t) => t.id === themeId);
        setThemeId(THEMES[(i + 1) % THEMES.length]!.id);
      }),
    );
    if (active) {
      items.push(
        cmd("cmd:pinPane", panePins.has(active.focusedPaneId) ? "Unpin pane" : "Pin pane", "⌘P",
          () => togglePanePin(active.focusedPaneId)),
        cmd("cmd:popout", popped.has(active.focusedPaneId) ? "Put pane back" : "Pop pane out", "",
          () => {
            const spec = active.panes[active.focusedPaneId];
            togglePopout(active.focusedPaneId, spec?.title || spec?.kind || "pane");
          }),
      );
    }
    return items;
  }, [worktrees, tabs, activeTabId, active, addTab, doSplit, doClosePane, togglePin,
      togglePanePin, togglePopout, popped, panePins, themeId]);

  // Phases advance on their own, so the main process pushes rather than being
  // polled -- a poll would either lag a 50s plan or hammer for nothing.
  useEffect(() => {
    const off = window.th.onHandoffChanged((cwd, state) => {
      setHandoffs((prev) => ({ ...prev, [cwd]: state as HandoffState }));
    });
    return off;
  }, []);

  /** Read the newest turn for the active workspace. */
  const loadKeel = useCallback(async () => {
    if (!active) return;
    setKeelLoading(true);
    try {
      const r = (await window.th.keelTurn(active.cwd, railPaneId)) as TurnReview;
      setKeelReview(r);
    } finally {
      setKeelLoading(false);
    }
  }, [active, railPaneId]);

  const loadWorklist = useCallback(async () => {
    if (!active) return;
    setWorklist((await window.th.keelWorklist(active.cwd)) as WorklistWire);
  }, [active]);

  /** Open a file card. Rule 4: two at a time, a third closes the oldest. */
  const openCard = useCallback(async (path: string) => {
    if (!active) return;
    setOpenCards((prev) => {
      if (prev.includes(path)) return prev;
      return [...prev, path].slice(-2);
    });
    if (cards[path]) return;
    const card = (await window.th.keelCard(active.cwd, path)) as CardWire;
    setCards((prev) => ({ ...prev, [path]: card }));
  }, [active, cards]);

  const loadIntents = useCallback(async () => {
    if (!active) return;
    setIntents((await window.th.intentsLoad(active.cwd)) as IntentsWire);
  }, [active]);

  const openKeel = useCallback(() => {
    setKeelOpen(true);
    setKeelView("workspace");
    void loadWorklist();
    void loadKeel();
    /*
     * Ask for the loop's current state rather than waiting for the next event.
     *
     * The subscription only delivers *changes*, so a loop that reached its gate
     * before this window opened -- or before a reload -- would render as idle
     * while it sat waiting on a human. Found by reloading mid-handoff.
     */
    if (active) {
      void (async () => {
        const s = (await window.th.handoffState(active.cwd)) as HandoffState;
        setHandoffs((prev) => ({ ...prev, [active.cwd]: s }));
      })();
    }
  }, [loadKeel, loadWorklist, active]);

  /*
   * Start watching every workspace as it becomes active.
   *
   * A boundary only exists if a snapshot was taken before the turn began, so
   * arming has to happen ahead of any review rather than when Keel opens --
   * by then the turn is already over.
   */
  useEffect(() => {
    if (!active?.cwd) return;
    void window.th.keelBegin(active.cwd);
  }, [active?.cwd]);

  /**
   * Breakpoints, owned here rather than in either pane.
   *
   * The editor sets them and the debugger sends them, so neither can be the
   * owner without the other reaching across. Held as a flat list because it is
   * small and both consumers want it whole.
   */
  const [breakpoints, setBreakpoints] = useState<{ path: string; line: number }[]>([]);
  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints((prev) => {
      const without = prev.filter((b) => !(b.path === path && b.line === line));
      const next = without.length === prev.length ? [...prev, { path, line }] : without;
      // The debugger owns the whole set for a file, so send that file's lines.
      void window.th.dbgBreakpoints(path, next.filter((b) => b.path === path).map((b) => b.line));
      return next;
    });
  }, []);

  /** Where execution is paused, so the editor can highlight the line. */
  const [pausedAt, setPausedAt] = useState<{ path: string; line: number } | null>(null);
  useEffect(() => {
    const off = window.th.onDbgStatus((raw) => {
      const s = raw as { state: string };
      if (s.state !== "paused") { setPausedAt(null); return; }
      // The top frame is where it stopped; ask for it and jump there.
      void (async () => {
        const frames = (await window.th.dbgStack()) as { path?: string; line: number }[];
        const top = frames[0];
        if (top?.path) {
          setPausedAt({ path: top.path, line: top.line });
          openInPaneRef.current(top.path, top.line);
        }
      })();
    });
    return off;
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => {
    // Refresh on open so the counts are current rather than whatever they were
    // when the tab was last switched.
    if (active?.cwd) void loadWorktrees(active.cwd);
    setPaletteOpen(true);
  }, [active?.cwd, loadWorktrees]);
  openPaletteRef.current = openPalette;
  openKeelRef.current = openKeel;

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
        <LayoutMenu presets={PRESETS} current={preset} onPick={applyPreset} />
        <Divider />
        <ToolButton label="Split" hint="⌘D" icon="▊▊" onClick={() => doSplit("row")} />
        <ToolButton label="Split down" hint="⌘⇧D" icon="▤" onClick={() => doSplit("column")} />
        <Divider />
        <ToolButton label="Claude" hint="⌘↵" icon="✳" onClick={() => doSplit("row", "claude")} />
        <ToolButton label="Shell" icon="❯" onClick={() => doSplit("row", "shell")} />
        <ToolButton label="Git" hint="⌘G" icon="⎇" onClick={() => doSplit("row", "git")} />
        <ToolButton label="Editor" hint="⌘E" icon="◧" onClick={() => doSplit("row", "editor")} />
        <ToolButton label="Agents" hint="⌘R" icon="◉" onClick={() => doSplit("row", "agents")} />
        <ToolButton label="Model" hint="⌘M" icon="◈" onClick={() => setPickerOpen(true)} />
        <ToolButton label="Search" hint="⌘⇧F" icon="⌕" onClick={() => doSplit("row", "search")} />
        <ToolButton label="Browser" hint="⌘B" icon="◍" onClick={() => doSplit("row", "browser")} />
        <ToolButton label="Debug" icon="◆" onClick={() => doSplit("row", "debug")} />
        <ToolButton label="Config" hint="⌘K" icon="⚙" onClick={() => doSplit("row", "config")} />
        <ToolButton
          label={THEMES.find((t) => t.id === themeId)?.label ?? "Theme"}
          icon="◐"
          onClick={() => {
            const i = THEMES.findIndex((t) => t.id === themeId);
            setThemeId(THEMES[(i + 1) % THEMES.length]!.id);
          }}
        />
        <Divider />
        <ToolButton
          label={active && panePins.has(active.focusedPaneId) ? "Unpin pane" : "Pin pane"}
          hint="⌘P"
          icon={active && panePins.has(active.focusedPaneId) ? "📌" : "⚲"}
          onClick={() => { if (active) togglePanePin(active.focusedPaneId); }}
        />
        <Divider />
        <ToolButton label="Open folder" hint="⌘T" icon="＋" onClick={() => void addTab()} />
        <ToolButton label="Go to…" hint="⌘O" icon="⎇" onClick={openPalette} />
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

      {paletteOpen && (
        <Palette
          items={paletteItems}
          empty={worktrees.length === 0 ? "not a git repository" : "nothing here"}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {pickerOpen && active && (
        <ModelPicker
          cwd={active.cwd}
          onClose={() => setPickerOpen(false)}
          onLaunch={launchProvider}
        />
      )}

      {/* A diff Claude is blocked on. One at a time; the rest wait behind it. */}
      {keelOpen && active && keelView === "workspace" && (
        <KeelWorkspace
          cwd={active.cwd}
          worklist={worklist}
          cards={cards}
          open={openCards}
          agent={keelReview ? {
            task: keelReview.turn?.prompt,
            running: keelReview.running,
          } : null}
          onOpenFile={(p) => void openCard(p)}
          onOpenInPane={(p) => {
            // Reading code is what the panes are for; the card is the summary
            // you decide from, not the place you read.
            setKeelOpen(false);
            openInPaneRef.current(`${active.cwd}/${p}`);
          }}
          onClose={() => setKeelOpen(false)}
          onShowTurn={() => setKeelView("turn")}
          onShowIntents={() => { setKeelView("intents"); void loadIntents(); }}
          handoff={handoffs[active.cwd] ?? initialHandoff()}
          onStart={(ticket, budget) => void window.th.handoffStart(active.cwd, ticket, budget)}
          onApprove={() => void window.th.handoffApprove(active.cwd)}
          onReplan={(note) => void window.th.handoffReplan(active.cwd, note)}
          onStopHandoff={() => void window.th.handoffStop(active.cwd)}
          onResetHandoff={() => void window.th.handoffReset(active.cwd)}
        />
      )}

      {keelOpen && active && keelView === "intents" && (
        <KeelIntents
          cwd={active.cwd}
          data={intents}
          results={mechResults}
          onRun={async (key, command) => {
            const r = (await window.th.intentsRun(active.cwd, command)) as
              { passed: boolean; output: string };
            setMechResults((prev) => ({ ...prev, [key]: r }));
          }}
          onAdopt={async (c) => {
            // Adopting copies the rule into your own store. The repository's
            // own file is never written to.
            const id = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "rule";
            await window.th.intentsSave(active.cwd, {
              id,
              headline: c.name,
              clauses: [{ num: "01", name: c.name, text: c.text, state: "unverifiable", source: c.from }],
            });
            void loadIntents();
          }}
          onBack={() => setKeelView("workspace")}
          onClose={() => setKeelOpen(false)}
        />
      )}

      {keelOpen && active && keelView === "turn" && (
        <Keel
          review={keelReview}
          loading={keelLoading}
          cwd={active.cwd}
          onClose={() => setKeelView("workspace")}
          onRefresh={() => void loadKeel()}
          onOpenFile={(path, line) => {
            // Opening a file is why you close Keel: the panes are the place to
            // read code, and the overlay was never meant to hold you.
            setKeelOpen(false);
            openInPaneRef.current(path, line);
          }}
        />
      )}

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
                      {spec.kind === "claude" ? (spec.providerLabel ? `✳ ${spec.providerLabel}` : "✳ claude")
                        : spec.kind === "git" ? "⎇ git"
                        : spec.kind === "editor" ? "◧ editor"
                        : spec.kind === "search" ? "⌕ search"
                        : spec.kind === "config" ? "⚙ config"
                        : spec.kind === "agents" ? "◉ agents"
                        : "❯ shell"}
                    </span>
                    <div style={S.grow} />
                    <button
                      style={{ ...S.paneClose, color: popped.has(paneId) ? C.accent : undefined }}
                      title={popped.has(paneId)
                        ? "Bring this pane back into the window"
                        : "Open this pane in its own window"}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePopout(paneId, spec.title || spec.kind);
                      }}
                    >
                      {popped.has(paneId) ? "⇱" : "⇲"}
                    </button>
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
                    {popped.has(paneId) ? (
                      // The pane lives in another window. Rendering it here too
                      // would attach a second terminal to the same PTY, which
                      // echoes twice and reads as a bug.
                      <div style={S.poppedOut}>
                        <div>this pane is open in its own window</div>
                        <button
                          style={S.poppedBtn}
                          onClick={() => togglePopout(paneId, spec.title || spec.kind)}
                        >
                          bring it back
                        </button>
                      </div>
                    ) : spec.kind === "git" ? (
                      <GitStatusPane cwd={spec.cwd ?? cwdOf(active)} onOpen={openInPane} />
                    ) : spec.kind === "editor" ? (
                      <EditorPane
                        key={spec.id}
                        cwd={spec.cwd ?? cwdOf(active)}
                        initialPath={spec.openPath}
                        initialLine={spec.openLine}
                        openNonce={spec.openNonce}
                        breakpoints={breakpoints}
                        onToggleBreakpoint={toggleBreakpoint}
                        pausedAt={pausedAt}
                        // Record the file the pane is really showing, so the
                        // persisted layout matches the screen and popping the
                        // pane out reopens what you were looking at.
                        onActivePathChange={(p) => noteEditorPath(spec.id, p)}
                      />
                    ) : spec.kind === "agents" ? (
                      <AgentsPane cwd={spec.cwd ?? cwdOf(active)} onOpen={openInPane} />
                    ) : spec.kind === "config" ? (
                      <ConfigPane cwd={spec.cwd ?? cwdOf(active)} onOpen={openInPane} />
                    ) : spec.kind === "search" ? (
                      <SearchPane cwd={spec.cwd ?? cwdOf(active)} onOpen={openInPane} />
                    ) : spec.kind === "browser" ? (
                      // `visible` is what hides the native view: a popped-out
                      // pane leaves a placeholder here, and the page must not
                      // keep painting over it.
                      <BrowserPane paneId={paneId} visible={!popped.has(paneId)} />
                    ) : spec.kind === "debug" ? (
                      <DebuggerPane
                        cwd={spec.cwd ?? cwdOf(active)}
                        breakpoints={breakpoints}
                        onOpen={openInPane}
                      />
                    ) : (
                      <TerminalPane
                        paneId={paneId}
                        focused={focused}
                        cwd={spec.cwd}
                        cmd={spec.kind === "claude" ? "claude" : undefined}
                        args={spec.kind === "claude" ? [] : undefined}
                        env={spec.providerEnv}
                      />
                    )}
                  </div>
                </div>
              );
            }}
          />
        </div>

        {/* Stats rail. Collapses to a spine; the toggle stays visible either way. */}
        <aside style={statsOpen ? S.rail : S.railClosed}>
          <div style={statsOpen ? S.railHeader : S.railHeaderClosed}>
            {statsOpen && <span>STATS</span>}
            {statsOpen && <div style={S.grow} />}
            <button
              onClick={() => setStatsOpen((v) => !v)}
              title={statsOpen ? "Hide stats" : "Show stats"}
              aria-label={statsOpen ? "Hide stats" : "Show stats"}
              aria-expanded={statsOpen}
              style={S.railToggle}
              onMouseEnter={(e) => { e.currentTarget.style.color = C.fg; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = C.faint; }}
            >
              {statsOpen ? "›" : "‹"}
            </button>
          </div>
          {statsOpen ? (
            <div style={S.railBody}>
              <TokensWidget snap={snap} />
              <AgentsWidget snap={snap} />
            </div>
          ) : (
            // Vertical label, so the spine still says what it opens.
            <div style={S.railSpine} onClick={() => setStatsOpen(true)}>STATS</div>
          )}
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
  tabs: {
    display: "flex", alignItems: "center", gap: 3,
    /*
     * Scrolls rather than clipping.
     *
     * Workspace tabs carry a branch name, so a handful of them overflow a
     * 1440px window -- measured at 567px past the edge with five open. Without
     * this the tabs past the fold are simply unreachable: no scrollbar, no
     * indication they exist.
     */
    minWidth: 0, overflowX: "auto", overflowY: "hidden",
    scrollbarWidth: "none",
    WebkitAppRegion: "no-drag",
  } as React.CSSProperties,
  tab: {
    display: "flex", alignItems: "center",
    padding: "4px 12px", borderRadius: 6, border: "1px solid transparent",
    background: "transparent", color: C.faint, cursor: "pointer", fontSize: 12,
    userSelect: "none",
    // Keeps its full width so the strip scrolls; without this the tabs
    // squash into each other and the labels become unreadable instead.
    flexShrink: 0, whiteSpace: "nowrap",
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
    /*
     * Scrolls rather than running off the window.
     *
     * Measured at 2007px of buttons in a 1440px window: everything from
     * "Config" rightwards was unreachable, with nothing on screen to say it
     * was there. The app root is `overflow: hidden`, so an over-wide row here
     * is clipped by the window rather than scrolled to.
     */
    minWidth: 0, overflowX: "auto", overflowY: "hidden",
    scrollbarWidth: "none",
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
  poppedOut: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", gap: 10, height: "100%",
    color: C.faint, fontSize: 11, fontFamily: "system-ui",
  },
  poppedBtn: {
    padding: "3px 12px", borderRadius: 4, border: `1px solid ${C.line}`,
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
  },
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
  railClosed: {
    width: 26, flexShrink: 0, marginLeft: 10,
    display: "flex", flexDirection: "column",
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
    overflow: "hidden",
  },
  railHeader: {
    display: "flex", alignItems: "center", gap: 4,
    padding: "5px 6px 5px 11px", fontSize: 10, letterSpacing: 0.6, color: C.faint,
    borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  railHeaderClosed: {
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "5px 0", borderBottom: `1px solid ${C.line}`, flexShrink: 0,
  },
  railToggle: {
    border: "1px solid transparent", background: "transparent", color: C.faint,
    borderRadius: 4, cursor: "pointer", fontSize: 13, lineHeight: "14px",
    padding: "1px 5px", transition: "color 90ms",
  },
  railSpine: {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    writingMode: "vertical-rl", fontSize: 10, letterSpacing: 1.2,
    color: C.faint, cursor: "pointer", userSelect: "none",
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
