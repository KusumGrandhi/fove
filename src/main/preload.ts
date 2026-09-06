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

  loadLayout: (): Promise<unknown> => ipcRenderer.invoke(CH.layoutLoad),
  saveLayout: (state: unknown): void => ipcRenderer.send(CH.layoutSave, state),
};

contextBridge.exposeInMainWorld("th", api);
export type ThApi = typeof api;
