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
} as const;
