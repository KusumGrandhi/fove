/**
 * Electron main process: owns the window, the PTYs, and persisted layout.
 *
 * Note: this app must NOT run with ELECTRON_RUN_AS_NODE set -- with it, Electron
 * executes this file as plain Node, `require("electron")` returns a path string,
 * and `app` is undefined. The npm start script clears it.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PtyService } from "./pty.js";
import { GitService } from "./git.js";
import { FileService } from "./files.js";
import { ClaudeSessionService, toWire } from "./claudeSession.js";
import { readClaudeJson } from "../data/config/claudeJson.js";
import { listSkills, sortSkills, budget, orphanUsage } from "../data/config/skills.js";
import { listMemories } from "../data/config/memory.js";
import { readSettings, setSkillOverride, nextOverride } from "../data/config/settingsFile.js";
import { listSessions } from "../data/transcript.js";
import { openInEditor, revealInFinder } from "./openExternal.js";
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

const gitSvc = new GitService();
const fileSvc = new FileService();
const claudeSvc = new ClaudeSessionService();

ipcMain.handle(CH.gitRoot, (_e, cwd: string) => gitSvc.root(cwd));
ipcMain.handle(CH.gitStatus, (_e, cwd: string) => gitSvc.status(cwd));
ipcMain.handle(CH.gitWorktrees, (_e, cwd: string) => gitSvc.worktrees(cwd));
ipcMain.handle(CH.gitDiff, (_e, cwd: string, opts: Record<string, unknown>) =>
  gitSvc.diff(cwd, opts as never),
);
ipcMain.handle(CH.gitUntrackedDiff, (_e, cwd: string, path: string) =>
  gitSvc.untrackedDiff(cwd, path),
);
ipcMain.handle(CH.gitLog, (_e, cwd: string, limit?: number) => gitSvc.log(cwd, limit));
ipcMain.on(CH.openInEditor, (_e, file: string, line?: number) => openInEditor(file, line));
ipcMain.on(CH.revealInFinder, (_e, file: string) => revealInFinder(file));
ipcMain.handle(CH.pickFolder, async () => {
  const { dialog } = await import("electron");
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle(CH.fileRead, (_e, path: string) => fileSvc.read(path));
ipcMain.handle(CH.fileWrite, (_e, path: string, content: string, mtimeMs?: number) =>
  fileSvc.write(path, content, mtimeMs),
);
ipcMain.handle(CH.fileList, (_e, dir: string) => fileSvc.list(dir));
ipcMain.handle(CH.filePick, async () => {
  const { dialog } = await import("electron");
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle(CH.claudeSnapshot, async (_e, cwd: string) => {
  const snap = await claudeSvc.snapshot(cwd);
  return snap ? { ...snap, agents: toWire(snap.agents) } : null;
});
ipcMain.handle(CH.claudeSessions, () => listSessions());

ipcMain.handle(CH.skillsList, async () => {
  const [cj, settings] = await Promise.all([readClaudeJson(), readSettings()]);
  const skills = await listSkills({
    usage: cj.skillUsage,
    overrides: (settings.skillOverrides ?? {}) as Record<string, string>,
  });
  return {
    skills: sortSkills(skills, "costPerUse"),
    budget: budget(skills),
    orphans: orphanUsage(skills, cj.skillUsage),
    mcp: cj.mcpServers,
  };
});
ipcMain.handle(CH.skillsToggle, async (_e, name: string, current?: string) => {
  await setSkillOverride(name, nextOverride(current as never));
  return true;
});
ipcMain.handle(CH.memoryList, () => listMemories());

ipcMain.handle(CH.appCwd, () => process.cwd());

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
  const repo = process.env.TH_SMOKE_REPO ?? process.cwd();
  try {
    // --- git service against an isolated fixture repo ---
    const root = await gitSvc.root(repo);
    v.root = !!root;
    const st = await gitSvc.status(repo);
    v.branch = st?.branch;
    v.changed = st?.files.length ?? 0;
    v.rename = st?.files.find((f) => f.from)?.from ?? null;
    v.worktrees = (await gitSvc.worktrees(repo)).length;
    const d = await gitSvc.diff(repo);
    v.diffFiles = d.length;
    v.hunkLineNumbers = d[0]?.hunks[0]?.lines.some((l) => typeof l.newNo === "number") ?? false;
    v.untracked = (await gitSvc.untrackedDiff(repo, "untracked.ts"))?.additions ?? 0;

    // --- the pane renders inside the real window ---
    await sleep(3000);
    const js = (code: string) => win!.webContents.executeJavaScript(code);
    const clickBtn = (re: string) =>
      js(`[...document.querySelectorAll("button")].find(b=>${re}.test(b.innerText))?.click(), 1`);
    const seq: Record<string, unknown> = {};

    // --- stats rail widgets ---
    await sleep(3500);
    seq.railTokens = await js(`!!document.body.innerText.match(/TOKENS/)`);
    seq.railAgents = await js(`!!document.body.innerText.match(/AGENTS/)`);
    seq.railSkills = await js(`!!document.body.innerText.match(/SKILLS/)`);
    seq.railHasNumbers = await js(`!!document.body.innerText.match(/\\d+(\\.\\d+)?[kM]\\b/)`);

    // --- agents pane ---
    await clickBtn("/\\bAgents\\b/"); await sleep(3000);
    seq.panes = await js(`document.querySelectorAll("[data-pane]").length`);
    seq.hasTimelineTab = await js(`!!document.body.innerText.match(/timeline/)`);
    seq.agentRows = await js(`document.body.innerText.split("\\n").filter(l=>/tok|Audit|Research|Design/.test(l)).length`);
    seq.railText = await js(`(document.body.innerText.match(/TOKENS[\\s\\S]{0,120}/)?.[0] ?? "").replace(/\\s+/g," ").slice(0,110)`);
    v.click = seq;
    await sleep(4000);
    v.paneCount = await win!.webContents.executeJavaScript(
      `document.querySelectorAll('[data-pane]').length`,
    ).catch(() => -1);
    v.gitPaneMounted = await win!.webContents.executeJavaScript(
      `!!document.body.innerText.match(/⎇|worktrees|select a file/i)`,
    );
    // xterm draws to canvas, so the terminal pane contributes no innerText;
    // read the last pane that has any, which is the git pane.
    const probe = `(()=>{const p=[...document.querySelectorAll('[data-pane]')];return JSON.stringify({panes:p.length,headers:p.map(e=>(e.innerText||"").split("\\n").slice(0,2).join(" ").trim()).filter(Boolean)})})()`;
    await sleep(2500);
    v.after = (await win!.webContents.executeJavaScript(probe)) as string;
  } catch (e) {
    v.error = String(e);
  }
  console.log("SMOKE " + JSON.stringify(v));
  app.quit();
}
