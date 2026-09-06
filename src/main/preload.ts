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
  gitBlame: "git:blame",
  gitBranches: "git:branches",
  openInEditor: "open:editor",
  revealInFinder: "open:finder",
  pickFolder: "dialog:folder",
  fileRead: "file:read",
  fileWrite: "file:write",
  fileList: "file:list",
  filePick: "dialog:file",
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
  bgSessions: "sessions:background",
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

  claudeSnapshot: (cwd: string): Promise<unknown> =>
    ipcRenderer.invoke(CH.claudeSnapshot, cwd),
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
  gitCommits: (cwd: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitCommits, cwd, limit),
  gitBlame: (cwd: string, path: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH.gitBlame, cwd, path),
  gitBranches: (cwd: string): Promise<unknown[]> => ipcRenderer.invoke(CH.gitBranches, cwd),

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

  appCwd: (): Promise<string> => ipcRenderer.invoke(CH.appCwd),

  loadLayout: (): Promise<unknown> => ipcRenderer.invoke(CH.layoutLoad),
  saveLayout: (state: unknown): void => ipcRenderer.send(CH.layoutSave, state),
};

contextBridge.exposeInMainWorld("th", api);
export type ThApi = typeof api;
