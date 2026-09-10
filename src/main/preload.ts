/** The only bridge between renderer and main. Context-isolated by design. */

import { contextBridge, ipcRenderer } from "electron";

/**
 * Channel names are duplicated here rather than imported: Electron loads the
 * preload as a single file with no module resolution, so any bare import fails
 * at runtime with "module not found". Kept in sync with src/shared/ipc.ts.
 */
const CH = {
  ptySpawn: "pty:spawn",
  ptyInput: "pty:input",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  layoutLoad: "layout:load",
  layoutSave: "layout:save",
  gitStatus: "git:status",
  gitWorktrees: "git:worktrees",
  gitDiff: "git:diff",
  gitUntrackedDiff: "git:untracked-diff",
  gitLog: "git:log",
  gitRoot: "git:root",
  gitStage: "git:stage",
  gitUnstage: "git:unstage",
  gitDiscard: "git:discard",
  gitCommit: "git:commit",
  gitPush: "git:push",
  gitPull: "git:pull",
  gitFetch: "git:fetch",
  gitStashPush: "git:stash-push",
  gitStashPop: "git:stash-pop",
  gitStashApply: "git:stash-apply",
  gitStashDrop: "git:stash-drop",
  gitStashList: "git:stash-list",
  gitCommits: "git:commits",
  gitCommitParents: "git:commit-parents",
  keelTurn: "keel:turn",
  keelBegin: "keel:begin",
  keelWorklist: "keel:worklist",
  keelCard: "keel:card",
  intentsLoad: "intents:load",
  intentsSave: "intents:save",
  intentsRun: "intents:run",
  handoffState: "handoff:state",
  handoffPause: "handoff:pause",
  handoffStart: "handoff:start",
  handoffApprove: "handoff:approve",
  handoffReplan: "handoff:replan",
  handoffStop: "handoff:stop",
  handoffReset: "handoff:reset",
  handoffChanged: "handoff:changed",
  gitBlame: "git:blame",
  gitBranches: "git:branches",
  openInEditor: "open:editor",
  revealInFinder: "open:finder",
  pickFolder: "dialog:folder",
  fileRead: "file:read",
  fileWrite: "file:write",
  fileList: "file:list",
  filePick: "dialog:file",
  fsCreateFile: "fs:create-file",
  fsCreateDir: "fs:create-dir",
  fsRename: "fs:rename",
  fsDuplicate: "fs:duplicate",
  fsTrash: "fs:trash",
  fsWatch: "fs:watch",
  fsChanged: "fs:changed",
  wsRecipe: "ws:recipe",
  wsSaveRecipe: "ws:save-recipe",
  browserNavigate: "browser:navigate",
  browserBounds: "browser:bounds",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserDevTools: "browser:devtools",
  browserConsole: "browser:console",
  browserNetwork: "browser:network",
  browserClear: "browser:clear",
  browserClose: "browser:close",
  browserState: "browser:state",
  dbgConfigs: "dbg:configs",
  dbgStart: "dbg:start",
  dbgStop: "dbg:stop",
  dbgBreakpoints: "dbg:breakpoints",
  dbgContinue: "dbg:continue",
  dbgStepOver: "dbg:step-over",
  dbgStepIn: "dbg:step-in",
  dbgStepOut: "dbg:step-out",
  dbgPause: "dbg:pause",
  dbgStack: "dbg:stack",
  dbgScopes: "dbg:scopes",
  dbgVariables: "dbg:variables",
  dbgEvaluate: "dbg:evaluate",
  dbgInterpreters: "dbg:interpreters",
  dbgStatus: "dbg:status",
  dbgOutput: "dbg:output",
  wtList: "wt:list",
  wtRemove: "wt:remove",
  wsCreate: "ws:create-worktree",
  wsApply: "ws:apply-recipe",
  popoutOpen: "popout:open",
  popoutClose: "popout:close",
  popoutList: "popout:list",
  popoutClosed: "popout:closed",
  searchStart: "search:start",
  searchCancel: "search:cancel",
  searchMatch: "search:match",
  searchDone: "search:done",
  lintCheck: "lint:check",
  claudeSnapshot: "claude:snapshot",
  claudeSessions: "claude:sessions",
  skillsList: "skills:list",
  skillsToggle: "skills:toggle",
  memoryList: "memory:list",
  appCwd: "app:cwd",
  teamsList: "teams:list",
  teamCapture: "teams:capture",
  teamSend: "teams:send",
  teamInterrupt: "teams:interrupt",
  teamIsolate: "teams:isolate",
  teamRejoin: "teams:rejoin",
  bgSessions: "sessions:background",
  providers: "models:providers",
  agentsList: "config:agents",
  mcpList: "config:mcp",
  ideOpenFile: "ide:openFile",
  ideOpenDiff: "ide:openDiff",
  ideDiffResult: "ide:diffResult",
  ideStatus: "ide:status",
  ideSelection: "ide:selection",
  ideEditors: "ide:editors",
} as const;

interface SpawnRequest {
  paneId: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
  /** Extra environment, e.g. a third-party provider's base URL. */
  env?: Record<string, string>;
}

const api = {
  spawn: (req: SpawnRequest): Promise<{ fresh: boolean; scrollback: string }> =>
    ipcRenderer.invoke(CH.ptySpawn, req),
  input: (paneId: string, data: string): void => ipcRenderer.send(CH.ptyInput, paneId, data),
  resize: (paneId: string, cols: number, rows: number): void =>
    ipcRenderer.send(CH.ptyResize, paneId, cols, rows),
  kill: (paneId: string): void => ipcRenderer.send(CH.ptyKill, paneId),

  onData: (cb: (paneId: string, data: string) => void): (() => void) => {
    const h = (_e: unknown, paneId: string, data: string) => cb(paneId, data);
    ipcRenderer.on(CH.ptyData, h);
    return () => ipcRenderer.removeListener(CH.ptyData, h);
  },
  onExit: (cb: (paneId: string, code: number) => void): (() => void) => {
    const h = (_e: unknown, paneId: string, code: number) => cb(paneId, code);
    ipcRenderer.on(CH.ptyExit, h);
    return () => ipcRenderer.removeListener(CH.ptyExit, h);
  },

  gitRoot: (cwd: string): Promise<string | null> => ipcRenderer.invoke(CH.gitRoot, cwd),
  gitStatus: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.gitStatus, cwd),
  gitWorktrees: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.gitWorktrees, cwd),
  gitDiff: (cwd: string, opts: Record<string, unknown> = {}): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitDiff, cwd, opts),
  gitUntrackedDiff: (cwd: string, path: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitUntrackedDiff, cwd, path),
  gitLog: (cwd: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitLog, cwd, limit),
  openInEditor: (file: string, line?: number): void =>
    ipcRenderer.send(CH.openInEditor, file, line),
  revealInFinder: (file: string): void => ipcRenderer.send(CH.revealInFinder, file),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CH.pickFolder),

  fileRead: (path: string): Promise<unknown> => ipcRenderer.invoke(CH.fileRead, path),
  fileWrite: (path: string, content: string, mtimeMs?: number): Promise<unknown> =>
    ipcRenderer.invoke(CH.fileWrite, path, content, mtimeMs),
  fileList: (dir: string): Promise<unknown[]> => ipcRenderer.invoke(CH.fileList, dir),
  filePick: (): Promise<string | null> => ipcRenderer.invoke(CH.filePick),

// ---- file tree ----------------------------------------------------------
  fsCreateFile: (path: string): Promise<unknown> => ipcRenderer.invoke(CH.fsCreateFile, path),
  fsCreateDir: (path: string): Promise<unknown> => ipcRenderer.invoke(CH.fsCreateDir, path),
  fsRename: (from: string, to: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.fsRename, from, to),
  fsDuplicate: (path: string): Promise<unknown> => ipcRenderer.invoke(CH.fsDuplicate, path),
  fsTrash: (path: string): Promise<unknown> => ipcRenderer.invoke(CH.fsTrash, path),
  /** Watch exactly these directories; replaces any previous set. */
  fsWatch: (dirs: string[]): void => ipcRenderer.send(CH.fsWatch, dirs),
  onFsChanged: (fn: (dir: string) => void): (() => void) => {
    const h = (_e: unknown, dir: string): void => fn(dir);
    ipcRenderer.on(CH.fsChanged, h);
    return () => { ipcRenderer.removeListener(CH.fsChanged, h); };
  },

  /** The setup recipe for a repo, or a suggestion when it has none. */
  wsRecipe: (repoRoot: string): Promise<unknown> => ipcRenderer.invoke(CH.wsRecipe, repoRoot),
  wsSaveRecipe: (repoRoot: string, recipe: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CH.wsSaveRecipe, repoRoot, recipe),
  browserNavigate: (paneId: string, url: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.browserNavigate, paneId, url),
  browserBounds: (paneId: string, bounds: unknown): void =>
    ipcRenderer.send(CH.browserBounds, paneId, bounds),
  browserBack: (paneId: string): void => ipcRenderer.send(CH.browserBack, paneId),
  browserForward: (paneId: string): void => ipcRenderer.send(CH.browserForward, paneId),
  browserReload: (paneId: string, hard?: boolean): void =>
    ipcRenderer.send(CH.browserReload, paneId, hard),
  browserDevTools: (paneId: string): void => ipcRenderer.send(CH.browserDevTools, paneId),
  browserConsole: (paneId: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.browserConsole, paneId),
  browserNetwork: (paneId: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.browserNetwork, paneId),
  browserClear: (paneId: string): void => ipcRenderer.send(CH.browserClear, paneId),
  browserClose: (paneId: string): void => ipcRenderer.send(CH.browserClose, paneId),
  onBrowserState: (fn: (paneId: string, state: unknown) => void): (() => void) => {
    const h = (_e: unknown, paneId: string, state: unknown): void => fn(paneId, state);
    ipcRenderer.on(CH.browserState, h);
    return () => { ipcRenderer.off(CH.browserState, h); };
  },
  dbgConfigs: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.dbgConfigs, cwd),
  dbgInterpreters: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.dbgInterpreters, cwd),
  dbgStart: (opts: unknown): Promise<unknown> => ipcRenderer.invoke(CH.dbgStart, opts),
  dbgStop: (): Promise<void> => ipcRenderer.invoke(CH.dbgStop),
  dbgBreakpoints: (path: string, lines: number[]): Promise<void> =>
    ipcRenderer.invoke(CH.dbgBreakpoints, path, lines),
  dbgContinue: (): void => ipcRenderer.send(CH.dbgContinue),
  dbgStepOver: (): void => ipcRenderer.send(CH.dbgStepOver),
  dbgStepIn: (): void => ipcRenderer.send(CH.dbgStepIn),
  dbgStepOut: (): void => ipcRenderer.send(CH.dbgStepOut),
  dbgPause: (): void => ipcRenderer.send(CH.dbgPause),
  dbgStack: (): Promise<unknown[]> => ipcRenderer.invoke(CH.dbgStack),
  dbgScopes: (frameId: number): Promise<unknown[]> => ipcRenderer.invoke(CH.dbgScopes, frameId),
  dbgVariables: (reference: number): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.dbgVariables, reference),
  dbgEvaluate: (expression: string, frameId?: number): Promise<unknown> =>
    ipcRenderer.invoke(CH.dbgEvaluate, expression, frameId),
  onDbgStatus: (fn: (status: unknown) => void): (() => void) => {
    const h = (_e: unknown, status: unknown): void => fn(status);
    ipcRenderer.on(CH.dbgStatus, h);
    return () => { ipcRenderer.off(CH.dbgStatus, h); };
  },
  onDbgOutput: (fn: (text: string, category: string) => void): (() => void) => {
    const h = (_e: unknown, text: string, category: string): void => fn(text, category);
    ipcRenderer.on(CH.dbgOutput, h);
    return () => { ipcRenderer.off(CH.dbgOutput, h); };
  },
  wtList: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.wtList, cwd),
  /**
   * Close a worktree. Refusals come back as { ok: false, error } — not a throw.
   * `retryWithForce` marks the only refusal a retry can get past.
   */
  wtRemove: (
    cwd: string,
    path: string,
    force?: boolean,
  ): Promise<{ ok: boolean; error?: string; retryWithForce?: boolean }> =>
    ipcRenderer.invoke(CH.wtRemove, cwd, path, force),
  wsCreate: (opts: unknown): Promise<unknown> => ipcRenderer.invoke(CH.wsCreate, opts),
  wsApply: (worktree: string, primary: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.wsApply, worktree, primary),

  /** Move a pane into its own window; the PTY is not restarted. */
  popoutOpen: (paneId: string, title: string): void =>
    ipcRenderer.send(CH.popoutOpen, paneId, title),
  popoutClose: (paneId: string): void => ipcRenderer.send(CH.popoutClose, paneId),
  popoutList: (): Promise<string[]> => ipcRenderer.invoke(CH.popoutList),
  /** Fires when the user closes a popped window, so the pane can come home. */
  onPopoutClosed: (fn: (paneId: string) => void): (() => void) => {
    const h = (_e: unknown, paneId: string): void => fn(paneId);
    ipcRenderer.on(CH.popoutClosed, h);
    return () => { ipcRenderer.removeListener(CH.popoutClosed, h); };
  },
  /** The pane this window is dedicated to, when it is a popped-out one. */
  popoutPaneId: (): string | null =>
    new URLSearchParams(window.location.search).get("popout"),

  /** Start a search; results stream back via onSearchMatch. */
  searchStart: (id: string, query: unknown): void =>
    ipcRenderer.send(CH.searchStart, id, query),
  searchCancel: (id: string): void => ipcRenderer.send(CH.searchCancel, id),
  onSearchMatch: (fn: (id: string, matches: unknown[]) => void): (() => void) => {
    const h = (_e: unknown, id: string, m: unknown[]): void => fn(id, m);
    ipcRenderer.on(CH.searchMatch, h);
    return () => { ipcRenderer.removeListener(CH.searchMatch, h); };
  },
  onSearchDone: (fn: (id: string, count: number, truncated: boolean) => void): (() => void) => {
    const h = (_e: unknown, id: string, c: number, t: boolean): void => fn(id, c, t);
    ipcRenderer.on(CH.searchDone, h);
    return () => { ipcRenderer.removeListener(CH.searchDone, h); };
  },
  /** Diagnostics for one file, for languages Monaco cannot check itself. */
  lintCheck: (path: string, cwd?: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.lintCheck, path, cwd),

  claudeSnapshot: (cwd: string, paneId?: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.claudeSnapshot, cwd, paneId),
  claudeSessions: (): Promise<unknown[]> => ipcRenderer.invoke(CH.claudeSessions),
  skillsList: (): Promise<unknown> => ipcRenderer.invoke(CH.skillsList),
  skillsToggle: (name: string, current?: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.skillsToggle, name, current),
  memoryList: (): Promise<unknown[]> => ipcRenderer.invoke(CH.memoryList),

// ---- git write ----------------------------------------------------------
  gitStage: (cwd: string, paths: string[]): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitStage, cwd, paths),
  gitUnstage: (cwd: string, paths: string[]): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitUnstage, cwd, paths),
  gitDiscard: (cwd: string, paths: string[]): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitDiscard, cwd, paths),
  gitCommit: (cwd: string, message: string, opts?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitCommit, cwd, message, opts),
  gitPush: (cwd: string, opts?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitPush, cwd, opts),
  gitPull: (cwd: string, opts?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitPull, cwd, opts),
  gitFetch: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.gitFetch, cwd),
  gitStashPush: (cwd: string, message?: string, untracked?: boolean): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitStashPush, cwd, message, untracked),
  gitStashPop: (cwd: string, ref?: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitStashPop, cwd, ref),
  gitStashApply: (cwd: string, ref?: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitStashApply, cwd, ref),
  gitStashDrop: (cwd: string, ref?: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.gitStashDrop, cwd, ref),
  gitStashList: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.gitStashList, cwd),
  gitCommits: (cwd: string, limit?: number, all?: boolean): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitCommits, cwd, limit, all),
  gitCommitParents: (cwd: string, commit: string): Promise<number> =>
    ipcRenderer.invoke(CH.gitCommitParents, cwd, commit),
  keelTurn: (cwd: string, paneId?: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.keelTurn, cwd, paneId),
  keelBegin: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.keelBegin, cwd),
  keelWorklist: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.keelWorklist, cwd),
  keelCard: (cwd: string, path: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.keelCard, cwd, path),
  intentsLoad: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.intentsLoad, cwd),
  intentsSave: (cwd: string, intent: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CH.intentsSave, cwd, intent),
  intentsRun: (cwd: string, command: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.intentsRun, cwd, command),

  handoffState: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.handoffState, cwd),
  handoffPause: (cwd: string, want: boolean): Promise<unknown> =>
    ipcRenderer.invoke(CH.handoffPause, cwd, want),
  handoffStart: (cwd: string, ticket: string, budgetUSD: number): Promise<unknown> =>
    ipcRenderer.invoke(CH.handoffStart, cwd, ticket, budgetUSD),
  handoffApprove: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.handoffApprove, cwd),
  handoffReplan: (cwd: string, note: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.handoffReplan, cwd, note),
  handoffStop: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.handoffStop, cwd),
  handoffReset: (cwd: string): Promise<unknown> => ipcRenderer.invoke(CH.handoffReset, cwd),
  onHandoffChanged: (
    fn: (
      cwd: string, state: unknown, changedSoFar: string[],
      pauseRequested: boolean, drifted: unknown[],
    ) => void,
  ): (() => void) => {
    const h = (
      _e: unknown, cwd: string, state: unknown,
      changedSoFar: string[] = [], pauseRequested = false, drifted: unknown[] = [],
    ): void => fn(cwd, state, changedSoFar, pauseRequested, drifted);
    ipcRenderer.on(CH.handoffChanged, h);
    return () => { ipcRenderer.off(CH.handoffChanged, h); };
  },
  gitBlame: (cwd: string, path: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitBlame, cwd, path),
  gitBranches: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.gitBranches, cwd),

  agentsList: (cwd?: string): Promise<unknown[]> => ipcRenderer.invoke(CH.agentsList, cwd),
  mcpList: (cwd?: string): Promise<unknown[]> => ipcRenderer.invoke(CH.mcpList, cwd),

  /** Providers plus Anthropic's verbatim unsupported-routing notice. */
  providers: (): Promise<unknown> => ipcRenderer.invoke(CH.providers),

  bgSessions: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.bgSessions, cwd),

  /** Claude asked to open a file or a diff in this app's editor. */
  onIdeOpenFile: (fn: (req: unknown) => void): (() => void) => {
    const h = (_e: unknown, req: unknown): void => fn(req);
    ipcRenderer.on(CH.ideOpenFile, h);
    return () => { ipcRenderer.removeListener(CH.ideOpenFile, h); };
  },
  onIdeOpenDiff: (fn: (req: unknown) => void): (() => void) => {
    const h = (_e: unknown, req: unknown): void => fn(req);
    ipcRenderer.on(CH.ideOpenDiff, h);
    return () => { ipcRenderer.removeListener(CH.ideOpenDiff, h); };
  },
  /** The user's verdict on a diff Claude is blocking on. */
  ideDiffResult: (id: string, verdict: "saved" | "rejected"): void =>
    ipcRenderer.send(CH.ideDiffResult, id, verdict),
  ideStatus: (): Promise<{ port: number; connected: boolean }> => ipcRenderer.invoke(CH.ideStatus),
  /** Tell Claude what the user just selected. */
  ideSelection: (sel: unknown): void => ipcRenderer.send(CH.ideSelection, sel),
  /** Keep the main process's view of open editors current. */
  ideEditors: (editors: unknown[]): void => ipcRenderer.send(CH.ideEditors, editors),

  teamsList: (): Promise<unknown[]> => ipcRenderer.invoke(CH.teamsList),
  teamCapture: (socket: string, paneId: string, lines?: number): Promise<string> =>
    ipcRenderer.invoke(CH.teamCapture, socket, paneId, lines),
  teamSend: (socket: string, paneId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.teamSend, socket, paneId, text),
  teamInterrupt: (socket: string, paneId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.teamInterrupt, socket, paneId),
  /**
   * Give a teammate's pane its own window.
   *
   * Resolves to the window to attach to, plus the window it came from so the
   * caller can put it back. `origin` is null when the pane was already alone.
   */
  teamIsolate: (
    socket: string,
    paneId: string,
  ): Promise<{ window: string; origin: string | null } | null> =>
    ipcRenderer.invoke(CH.teamIsolate, socket, paneId),
  /** Put the pane back in the shared window it came from. */
  teamRejoin: (socket: string, paneId: string, windowId: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.teamRejoin, socket, paneId, windowId),

  appCwd: (): Promise<string> => ipcRenderer.invoke(CH.appCwd),

  loadLayout: (): Promise<unknown> => ipcRenderer.invoke(CH.layoutLoad),
  saveLayout: (state: unknown): void => ipcRenderer.send(CH.layoutSave, state),
};

contextBridge.exposeInMainWorld("th", api);
export type ThApi = typeof api;
