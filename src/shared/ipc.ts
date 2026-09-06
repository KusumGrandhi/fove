/** Channel names and payload types shared by main and renderer. */

export interface SpawnRequest {
  paneId: string;
  /** Command to run. Defaults to the user's login shell. */
  cmd?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

export const CH = {
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
} as const;
