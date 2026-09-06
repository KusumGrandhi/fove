/**
 * Electron main process: owns the window, the PTYs, and persisted layout.
 *
 * Note: this app must NOT run with ELECTRON_RUN_AS_NODE set -- with it, Electron
 * executes this file as plain Node, `require("electron")` returns a path string,
 * and `app` is undefined. The npm start script clears it.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { PtyService } from "./pty.js";
import { loadState, saveState } from "./store.js";
import { CH, type SpawnRequest } from "../shared/ipc.js";

let win: BrowserWindow | null = null;

const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

const ptys = new PtyService(
  (paneId, data) => send(CH.ptyData, paneId, data),
  (paneId, code) => send(CH.ptyExit, paneId, code),
);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: "#101014",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../../renderer/index.html"));

  win.webContents.on("console-message", (_e, _lvl, msg) => {
    if (process.env.TH_SMOKE) console.log("RENDERER:", msg.slice(0, 200));
  });
  win.webContents.on("did-fail-load", (_e, code, desc) =>
    console.log("LOAD-FAIL:", code, desc),
  );
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  // TH_SMOKE=1 drives a scripted check and prints a verdict, for CI/dev.
  if (process.env.TH_SMOKE) void runSmoke();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  ptys.killAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => ptys.killAll());

// ---- IPC ------------------------------------------------------------------

ipcMain.handle(CH.ptySpawn, (_e, req: SpawnRequest) => {
  const fresh = !ptys.has(req.paneId);
  ptys.spawn(req);
  // Replay history so a remounted pane keeps its scrollback.
  return { fresh, scrollback: fresh ? "" : ptys.scrollback(req.paneId) };
});

ipcMain.on(CH.ptyInput, (_e, paneId: string, data: string) => ptys.write(paneId, data));
ipcMain.on(CH.ptyResize, (_e, paneId: string, cols: number, rows: number) =>
  ptys.resize(paneId, cols, rows),
);
ipcMain.on(CH.ptyKill, (_e, paneId: string) => ptys.kill(paneId));

ipcMain.handle(CH.layoutLoad, () => loadState<unknown>(null));
ipcMain.on(CH.layoutSave, (_e, state: unknown) => saveState(state));

// ---- smoke test -----------------------------------------------------------

/**
 * Drives the real app: waits for a pane's PTY, types a command, and asserts the
 * output comes back. Proves the renderer <-> main <-> pty loop end to end.
 */
async function runSmoke(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const v: Record<string, unknown> = {};
  const sessions = () => [...(ptys as unknown as { sessions: Map<string, unknown> }).sessions.keys()];
  const press = (key: string) =>
    win!.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(key)},metaKey:true,bubbles:true}))`,
    );

  try {
    await sleep(3500);
    v.pty1 = sessions().length;

    // Round-trip a command through the first pane.
    const first = sessions()[0]!;
    ptys.write(first, "echo TH-SMOKE-$((6*7))\r");
    await sleep(1500);
    v.roundTrip = /TH-SMOKE-42/.test(ptys.scrollback(first));

    // Split (cmd+D) -> a second PTY must appear.
    await press("d");
    await sleep(2500);
    v.pty2 = sessions().length;
    v.splitWorked = sessions().length === 2;

    // Open claude in a pane (cmd+Enter) and wait for its UI to draw.
    await press("Enter");
    for (let i = 0; i < 40 && sessions().length < 3; i++) await sleep(250);
    v.pty3 = sessions().length;
    const claudeId = sessions()[2];
    if (claudeId) {
      let ok = false;
      let answered = false;
      for (let i = 0; i < 80; i++) {
        await sleep(500);
        const out = ptys.scrollback(claudeId).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        // Answer the trust prompt once, then give it time to move on.
        if (!answered && /trust this folder/i.test(out)) {
          answered = true;
          ptys.write(claudeId, "\r");
          await sleep(2500);
          continue;
        }
        if (/Claude Code v|╭─|Welcome to Claude/i.test(out)) { ok = true; break; }
      }
      v.claudeRendered = ok;
      v.claudeBytes = ptys.scrollback(claudeId).length;
      v.claudeAlive = ptys.has(claudeId);
      // Can this pty accept input at all?
      const before = ptys.scrollback(claudeId).length;
      ptys.write(claudeId, "\r");
      await sleep(2000);
      v.grewAfterWrite = ptys.scrollback(claudeId).length - before;
      const after = ptys.scrollback(claudeId).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
      if (/Claude Code|╭─/.test(after)) ok = true;
      v.claudeRendered = ok;
      v.claudeTail = ptys.scrollback(claudeId)
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .split(/\r?\n/).filter((l) => l.trim()).slice(-4).map((l) => l.slice(0, 64));
    }

    // Layout must have been persisted with all three panes.
    await sleep(800);
    const saved = loadState<{ tabs?: { tree?: unknown }[] }>({} as never);
    v.layoutSaved = Array.isArray(saved.tabs) && saved.tabs.length > 0;
    v.panesPersisted = JSON.stringify(saved).match(/"paneId"/g)?.length ?? 0;
  } catch (e) {
    v.error = String(e);
  }
  console.log("SMOKE " + JSON.stringify(v));
  app.quit();
}
