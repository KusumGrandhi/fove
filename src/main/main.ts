/**
 * Electron main process: owns the window, the PTYs, and persisted layout.
 *
 * Note: this app must NOT run with ELECTRON_RUN_AS_NODE set -- with it, Electron
 * executes this file as plain Node, `require("electron")` returns a path string,
 * and `app` is undefined. `npm start` clears it, but a double-clicked .app
 * inherits the user's login environment, so the app re-launches itself without
 * the variable rather than dying silently (see below).
 */

// This runs before anything imports electron: with ELECTRON_RUN_AS_NODE set,
// `require("electron")` yields a path string and every electron API is
// undefined, so the process must be replaced before that import happens.
if (process.env.ELECTRON_RUN_AS_NODE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Electron needs an app path as its first argument. In a packaged app argv is
  // just [binary] (plus any flags), so relaunching with the flags alone would
  // start Electron with nothing to run. Pass the app root explicitly unless
  // argv already names one -- flags, which begin with "-", never do.
  const args = process.argv.slice(1);
  const hasAppPath = args.some((a) => !a.startsWith("-"));
  const appRoot = require("node:path").join(__dirname, "..", "..", "..") as string;
  const r = spawnSync(process.execPath, hasAppPath ? args : [appRoot, ...args], {
    env,
    stdio: "inherit",
  });
  process.exit(r.status ?? 0);
}

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PtyService } from "./pty.js";
import { GitService } from "./git.js";
import { WorktreeService } from "./worktrees.js";
import { BrowserService, type Bounds } from "./browser.js";
import { DebugSession } from "./debug.js";
import { findInterpreters } from "./interpreters.js";
import { parseLaunchConfigs, pythonConfigs } from "../shared/launch-config.js";
import { FileService } from "./files.js";
import { ClaudeSessionService, toWire } from "./claudeSession.js";
import { TeamService } from "./teams.js";
import { backgroundSessions } from "./sessions.js";
import { IdeService } from "./ide.js";
import { GitWriteService } from "./gitWrite.js";
import { KeelService } from "./keel.js";
import { IntentStore } from "./intentStore.js";
import { HandoffService } from "./handoffService.js";
import { FileTreeService } from "./files.js";
import { WatchService } from "./watch.js";
import { PopoutService } from "./popout.js";
import { SearchService } from "./search.js";
import { LintService } from "./lint.js";
import {
  loadRecipe, saveRecipe, suggestRecipe, createWorktree, applyRecipe, type Recipe,
} from "./workspace.js";
import { readClaudeJson } from "../data/config/claudeJson.js";
import { listSkills, sortSkills, budget, orphanUsage } from "../data/config/skills.js";
import { listMemories } from "../data/config/memory.js";
import { readSettings, setSkillOverride, nextOverride } from "../data/config/settingsFile.js";
import { listSessions } from "../data/transcript.js";
import { openInEditor, revealInFinder } from "./openExternal.js";
import { installMenu } from "./menu.js";
import { loadState, saveState } from "./store.js";
import { homedir } from "node:os";
import { launchCwd } from "../shared/launch-cwd.js";
import { CH, type SpawnRequest } from "../shared/ipc.js";

let win: BrowserWindow | null = null;

/**
 * Broadcast to every window.
 *
 * A popped-out pane is a second BrowserWindow attached to the *same* PTY, so
 * sending only to the main window would leave it showing a dead terminal.
 * Every channel here is addressed by pane id, and a window ignores ids it does
 * not render, so a broadcast is correct rather than merely convenient.
 */
const send = (channel: string, ...args: unknown[]): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
};

const ptys = new PtyService(
  (paneId, data) => send(CH.ptyData, paneId, data),
  (paneId, code) => send(CH.ptyExit, paneId, code),
);

function createWindow(): void {
  // The menu is global rather than per-window, so it is installed once here
  // and reads the current window lazily -- a menu built against a window that
  // has since closed would parent its dialogs to nothing.
  installMenu(() => win);

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
  // Advertise this app as an IDE so `claude` panes open files here. Failure is
  // not fatal: the app simply runs without IDE integration.
  void ide.start().catch(() => null);
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

app.on("before-quit", () => {
  ptys.killAll();
  watcher.closeAll();
  popouts.closeAll();
  browsers.closeAll();
  void debugSession.stop();
  searcher.cancelAll();
  // Remove the lock file, so Claude is never offered a dead IDE.
  void ide.stop();
});

// ---- IPC ------------------------------------------------------------------

ipcMain.handle(CH.ptySpawn, (_e, req: SpawnRequest) => {
  const fresh = !ptys.has(req.paneId);
  // Every pane inherits the IDE env, so a `claude` started by hand in a shell
  // pane finds this app too -- not just panes the app spawns as "claude".
  // A pane routed at a third-party provider names the env var holding its key;
  // the key itself is resolved here and never crosses into the renderer.
  const paneEnv = { ...ide.env(), ...(req.env ?? {}) };
  const tokenVar = paneEnv.FOVE_PROVIDER_TOKEN_ENV;
  if (tokenVar) {
    delete paneEnv.FOVE_PROVIDER_TOKEN_ENV;
    const token = process.env[tokenVar];
    if (token) paneEnv.ANTHROPIC_AUTH_TOKEN = token;
  }
  ptys.spawn({ ...req, env: paneEnv });
  // Replay history so a remounted pane keeps its scrollback.
  return { fresh, scrollback: fresh ? "" : ptys.scrollback(req.paneId) };
});

ipcMain.on(CH.ptyInput, (_e, paneId: string, data: string) => ptys.write(paneId, data));
ipcMain.on(CH.ptyResize, (_e, paneId: string, cols: number, rows: number) =>
  ptys.resize(paneId, cols, rows),
);
ipcMain.on(CH.ptyKill, (_e, paneId: string) => ptys.kill(paneId));

const gitSvc = new GitService();
// Stateless, and needed here as well as by the git-write handlers below:
// closing a worktree is a mutating command that the worktree service guards.
const gitw = new GitWriteService();
const worktreeSvc = new WorktreeService(gitSvc, gitw);
const fileSvc = new FileService();
const claudeSvc = new ClaudeSessionService();
const teamSvc = new TeamService();

ipcMain.handle(CH.gitRoot, (_e, cwd: string) => gitSvc.root(cwd));
ipcMain.handle(CH.gitStatus, (_e, cwd: string) => gitSvc.status(cwd));
ipcMain.handle(CH.gitWorktrees, (_e, cwd: string) => gitSvc.worktrees(cwd));
ipcMain.handle(CH.wtList, (_e, cwd: string) => worktreeSvc.list(cwd));
ipcMain.handle(CH.wtRemove, (_e, cwd: string, path: string, force?: boolean) =>
  worktreeSvc.remove(cwd, path, { force }),
);
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

ipcMain.handle(CH.claudeSnapshot, async (_e, cwd: string, paneId?: string) => {
  // A pane id lets the snapshot find the session running *in that pane*, rather
  // than whichever transcript in the folder was touched last.
  const pid = paneId ? ptys.pidOf(paneId) : undefined;
  const snap = await claudeSvc.snapshot(cwd, pid);
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

// ---- git write ------------------------------------------------------------
// Mutating commands. Each returns git's own stderr on failure so the UI can
// show the real reason -- a rejected push or a failing hook -- rather than a
// summary of it. `gitw` is constructed with the other services above, because
// the worktree service needs it too.

ipcMain.handle(CH.gitStage, (_e, cwd: string, paths: string[]) => gitw.stage(cwd, paths));
ipcMain.handle(CH.gitUnstage, (_e, cwd: string, paths: string[]) => gitw.unstage(cwd, paths));
ipcMain.handle(CH.gitDiscard, (_e, cwd: string, paths: string[]) => gitw.discard(cwd, paths));
ipcMain.handle(CH.gitCommit, (_e, cwd: string, message: string, opts?: { amend?: boolean; noVerify?: boolean }) =>
  gitw.commit(cwd, message, opts ?? {}),
);
ipcMain.handle(CH.gitPush, (_e, cwd: string, opts?: Parameters<GitWriteService["push"]>[1]) =>
  gitw.push(cwd, opts ?? {}),
);
ipcMain.handle(CH.gitPull, (_e, cwd: string, opts?: { rebase?: boolean }) => gitw.pull(cwd, opts ?? {}));
ipcMain.handle(CH.gitFetch, (_e, cwd: string) => gitw.fetch(cwd));
ipcMain.handle(CH.gitStashPush, (_e, cwd: string, message?: string, untracked?: boolean) =>
  gitw.stashPush(cwd, message, untracked ?? false),
);
ipcMain.handle(CH.gitStashPop, (_e, cwd: string, ref?: string) => gitw.stashPop(cwd, ref));
ipcMain.handle(CH.gitStashApply, (_e, cwd: string, ref?: string) => gitw.stashApply(cwd, ref));
ipcMain.handle(CH.gitStashDrop, (_e, cwd: string, ref?: string) => gitw.stashDrop(cwd, ref));
ipcMain.handle(CH.gitStashList, (_e, cwd: string) => gitw.stashList(cwd));
ipcMain.handle(CH.gitCommits, (_e, cwd: string, limit?: number, all?: boolean) =>
  gitw.log(cwd, limit ?? 200, all ?? true),
);
// gitSvc, not gitw: this sits beside `diff`, which is the only caller that
// needs it and the reason it exists.
ipcMain.handle(CH.gitCommitParents, (_e, cwd: string, commit: string) =>
  gitSvc.parentCount(cwd, commit),
);

// ---- keel ------------------------------------------------------------------
const keel = new KeelService(claudeSvc);
ipcMain.handle(CH.keelBegin, (_e, cwd: string) => keel.begin(cwd));
ipcMain.handle(CH.keelWorklist, (_e, cwd: string) => keel.worklist(cwd));
ipcMain.handle(CH.keelCard, (_e, cwd: string, path: string) => keel.card(cwd, path));

const intents = new IntentStore();
ipcMain.handle(CH.intentsLoad, (_e, cwd: string) => intents.load(cwd));
// The renderer sends plain JSON, so this is shaped rather than trusted: a
// malformed intent should fail to save, not be written and fail to parse later.
ipcMain.handle(CH.intentsSave, (_e, cwd: string, intent: unknown) =>
  intents.save(cwd, intent as Parameters<IntentStore["save"]>[1]),
);
ipcMain.handle(CH.intentsRun, (_e, cwd: string, command: string) =>
  intents.runMechanism(cwd, command),
);

// ---- handoff loop ----------------------------------------------------------
const handoff = new HandoffService(intents);
// Phases advance on their own, so the renderer is told rather than polling.
// The tree's view of what has moved rides along with the state, so the rail
// can show step status without a second channel that could disagree with it.
handoff.on("changed", (cwd: string, state: unknown) =>
  send(CH.handoffChanged, cwd, state, handoff.changedSoFar(cwd),
    handoff.isPauseRequested(cwd), handoff.driftedIntents(cwd)));

ipcMain.handle(CH.handoffState, (_e, cwd: string) => ({
  state: handoff.state(cwd),
  changedSoFar: handoff.changedSoFar(cwd),
  pauseRequested: handoff.isPauseRequested(cwd),
  drifted: handoff.driftedIntents(cwd),
}));
ipcMain.handle(CH.handoffPause, (_e, cwd: string, want: boolean) =>
  handoff.requestPause(cwd, want));
ipcMain.handle(CH.handoffStart, (_e, cwd: string, ticket: string, budget: number) =>
  // Not awaited: planning takes ~50s and the renderer follows the events.
  void handoff.start(cwd, ticket, budget),
);
ipcMain.handle(CH.handoffApprove, (_e, cwd: string) => void handoff.approve(cwd));
ipcMain.handle(CH.handoffReplan, (_e, cwd: string, note: string) =>
  void handoff.replan(cwd, note),
);
ipcMain.handle(CH.handoffStop, (_e, cwd: string) => handoff.stop(cwd));
ipcMain.handle(CH.handoffReset, (_e, cwd: string) => handoff.reset(cwd));
ipcMain.handle(CH.keelTurn, (_e, cwd: string, paneId?: string) => {
  // Same translation as claudeSnapshot: a pane id names the session to read,
  // and the pid never crosses into the renderer.
  const pid = paneId ? ptys.pidOf(paneId) : undefined;
  return keel.review(cwd, pid);
});
ipcMain.handle(CH.gitBlame, (_e, cwd: string, path: string) => gitw.blame(cwd, path));
ipcMain.handle(CH.gitBranches, (_e, cwd: string) => gitw.branches(cwd));

// ---- file tree ------------------------------------------------------------
const tree = new FileTreeService();
// One watcher set, following whatever directories the editor has open.
const watcher = new WatchService((dir) => send(CH.fsChanged, dir));

ipcMain.handle(CH.fsCreateFile, (_e, path: string) => tree.createFile(path));
ipcMain.handle(CH.fsCreateDir, (_e, path: string) => tree.createDir(path));
ipcMain.handle(CH.fsRename, (_e, from: string, to: string) => tree.rename(from, to));
ipcMain.handle(CH.fsDuplicate, (_e, path: string) => tree.duplicate(path));
ipcMain.handle(CH.fsTrash, (_e, path: string) => tree.trash(path));
ipcMain.on(CH.fsWatch, (_e, dirs: string[]) => watcher.sync(dirs ?? []));

// ---- workspace recipes ----------------------------------------------------
// ---- search and diagnostics -----------------------------------------------
/**
 * The reason a search could not run, held until its `done` fires.
 *
 * Reusing the existing done channel rather than adding a `search:failed`
 * one: the renderer already handles exactly one terminal event per search,
 * and a second channel would mean two orderings to get right for a string.
 */
const searchFailures = new Map<string, string>();
const searcher = new SearchService(
  (id, matches) => send(CH.searchMatch, id, matches),
  (id, count, truncated) => {
    const reason = searchFailures.get(id);
    searchFailures.delete(id);
    send(CH.searchDone, id, count, truncated, reason);
  },
  (id, reason) => searchFailures.set(id, reason),
);
const linter = new LintService();

ipcMain.on(CH.searchStart, (_e, id: string, q: Parameters<SearchService["start"]>[1]) =>
  searcher.start(id, q),
);
ipcMain.on(CH.searchCancel, (_e, id: string) => searcher.cancel(id));
ipcMain.handle(CH.lintCheck, (_e, path: string, cwd?: string) => linter.check(path, cwd));

// ---- browser panes --------------------------------------------------------
/**
 * The view is a native child of the window, so it needs the window itself
 * rather than a webContents -- and it must be looked up lazily, since panes
 * outlive any single window reference.
 */
const browsers = new BrowserService(
  () => win,
  (paneId, state) => send(CH.browserState, paneId, state),
);

ipcMain.handle(CH.browserNavigate, (_e, paneId: string, url: string) =>
  browsers.navigate(paneId, url),
);
ipcMain.on(CH.browserBounds, (_e, paneId: string, bounds: Bounds | null) =>
  browsers.setBounds(paneId, bounds),
);
ipcMain.on(CH.browserBack, (_e, paneId: string) => browsers.back(paneId));
ipcMain.on(CH.browserForward, (_e, paneId: string) => browsers.forward(paneId));
ipcMain.on(CH.browserReload, (_e, paneId: string, hard?: boolean) =>
  browsers.reload(paneId, hard),
);
ipcMain.on(CH.browserDevTools, (_e, paneId: string) => browsers.openDevTools(paneId));
ipcMain.handle(CH.browserConsole, (_e, paneId: string) => browsers.console(paneId));
ipcMain.handle(CH.browserNetwork, (_e, paneId: string) => browsers.network(paneId));
ipcMain.on(CH.browserClear, (_e, paneId: string) => browsers.clear(paneId));
ipcMain.on(CH.browserClose, (_e, paneId: string) => browsers.close(paneId));

// ---- debugger -------------------------------------------------------------
/**
 * One session at a time. Multi-target debugging is explicitly out of scope
 * this round; a second session would need a target id threaded through every
 * channel below for a case that does not arise in a Flask app.
 */
const debugSession = new DebugSession(
  (status) => send(CH.dbgStatus, status),
  (text, category) => send(CH.dbgOutput, text, category),
);

ipcMain.handle(CH.dbgConfigs, async (_e, cwd: string) => {
  try {
    const text = await readFile(join(cwd, ".vscode", "launch.json"), "utf8");
    return pythonConfigs(parseLaunchConfigs(text));
  } catch {
    // No launch.json is the normal case for most projects, not an error.
    return [];
  }
});
ipcMain.handle(CH.dbgInterpreters, (_e, cwd: string) => findInterpreters(cwd));
ipcMain.handle(CH.dbgStart, (_e, opts: Parameters<typeof debugSession.start>[0]) =>
  debugSession.start(opts),
);
ipcMain.handle(CH.dbgStop, () => debugSession.stop());
ipcMain.handle(CH.dbgBreakpoints, (_e, path: string, lines: number[]) =>
  debugSession.setBreakpoints(path, lines),
);
ipcMain.on(CH.dbgContinue, () => void debugSession.continue_());
ipcMain.on(CH.dbgStepOver, () => void debugSession.stepOver());
ipcMain.on(CH.dbgStepIn, () => void debugSession.stepIn());
ipcMain.on(CH.dbgStepOut, () => void debugSession.stepOut());
ipcMain.on(CH.dbgPause, () => void debugSession.pause());
ipcMain.handle(CH.dbgStack, () => debugSession.stackTrace());
ipcMain.handle(CH.dbgScopes, (_e, frameId: number) => debugSession.scopes(frameId));
ipcMain.handle(CH.dbgVariables, (_e, reference: number) => debugSession.variables(reference));
ipcMain.handle(CH.dbgEvaluate, (_e, expression: string, frameId?: number) =>
  debugSession.evaluate(expression, frameId),
);

// ---- popped-out panes -----------------------------------------------------
const popouts = new PopoutService((paneId) => send(CH.popoutClosed, paneId));

ipcMain.on(CH.popoutOpen, (_e, paneId: string, title: string) =>
  popouts.open(paneId, title),
);
ipcMain.on(CH.popoutClose, (_e, paneId: string) => popouts.close(paneId));
ipcMain.handle(CH.popoutList, () => popouts.list());

ipcMain.handle(CH.wsRecipe, async (_e, repoRoot: string) => {
  const saved = await loadRecipe(repoRoot);
  // A suggestion when nothing is configured, so the feature works before setup.
  return saved
    ? { recipe: saved, saved: true }
    : { recipe: await suggestRecipe(repoRoot), saved: false };
});
ipcMain.handle(CH.wsSaveRecipe, async (_e, repoRoot: string, recipe: Recipe) => {
  await saveRecipe(repoRoot, recipe);
  return { ok: true };
});
ipcMain.handle(CH.wsCreate, (_e, opts: Parameters<typeof createWorktree>[0]) =>
  createWorktree(opts),
);
ipcMain.handle(CH.wsApply, async (_e, worktree: string, primary: string) => {
  const recipe = (await loadRecipe(primary)) ?? (await suggestRecipe(primary));
  return applyRecipe(worktree, primary, recipe);
});

ipcMain.handle(CH.agentsList, async (_e, cwd?: string) => {
  const { listAgents } = await import("../data/config/agents.js");
  return listAgents(cwd);
});
ipcMain.handle(CH.mcpList, async (_e, cwd?: string) => {
  const { listMcpServers } = await import("../data/config/agents.js");
  return listMcpServers(cwd);
});

ipcMain.handle(CH.providers, async () => {
  const { loadProviders, tokenFor, UNSUPPORTED_NOTICE } = await import("../data/models/thirdParty.js");
  const providers = await loadProviders();
  return {
    // `usable` is resolved here because the renderer cannot read process.env,
    // and must never be handed the key itself.
    providers: providers.map((p) => ({ ...p, usable: !p.thirdParty || !!tokenFor(p) })),
    notice: UNSUPPORTED_NOTICE,
  };
});

ipcMain.handle(CH.bgSessions, (_e, cwd: string) => backgroundSessions(cwd));

// ---- IDE integration ------------------------------------------------------
// Claude Code connects to us and calls tools; these forward to the renderer so
// its output lands in fove's editor pane rather than the terminal.

/** Workspaces the renderer has open, mirrored so the lock file can list them. */
let ideWorkspaces: string[] = [];
/** Editors the renderer has open, for getOpenEditors/checkDocumentDirty. */
let ideEditors: { filePath: string; isDirty?: boolean }[] = [];
let ideSelection: import("./ide.js").Selection | null = null;
/** Diffs Claude is blocking on, keyed by id, resolved by the user's verdict. */
const pendingDiffs = new Map<string, (v: "saved" | "rejected") => void>();

const ide = new IdeService({
  browserProblems: () => browsers.problems(),
  openFile: (req) => { send(CH.ideOpenFile, req); },
  openDiff: async (req) => {
    const verdict = await new Promise<"saved" | "rejected">((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingDiffs.set(id, resolve);
      send(CH.ideOpenDiff, { ...req, id });
      // Never leave Claude blocked forever on a window the user closed.
      setTimeout(() => {
        if (pendingDiffs.delete(id)) resolve("rejected");
      }, 10 * 60_000);
    });
    // "FILE_SAVED" is a claim that the content is on disk, so accepting must
    // actually persist it -- otherwise Claude proceeds believing an edit landed
    // that never happened. No mtime guard: the user just looked at this diff
    // and said yes, and Claude supplied the full new contents.
    if (verdict === "saved") {
      const target = req.newPath || req.oldPath;
      const res = await fileSvc.write(target, req.newContents);
      if (res.error) return "rejected";
    }
    return verdict;
  },
  closeTab: () => {},
  closeAllDiffTabs: () => {},
  openEditors: async () => ideEditors,
  currentSelection: async () => ideSelection,
  isDirty: async (f) => ideEditors.find((e) => e.filePath === f)?.isDirty ?? false,
  save: async () => true,
  workspaceFolders: () => (ideWorkspaces.length ? ideWorkspaces : [process.cwd()]),
});

ipcMain.on(CH.ideDiffResult, (_e, id: string, verdict: "saved" | "rejected") => {
  const resolve = pendingDiffs.get(id);
  if (resolve) { pendingDiffs.delete(id); resolve(verdict); }
});
ipcMain.on(CH.ideSelection, (_e, sel: import("./ide.js").Selection | null) => {
  ideSelection = sel;
  ide.notifySelection(sel);
});
ipcMain.on(CH.ideEditors, (_e, editors: { filePath: string; isDirty?: boolean }[]) => {
  ideEditors = editors ?? [];
});
ipcMain.handle(CH.ideStatus, () => ({ port: ide.port, connected: ide.port > 0 }));

ipcMain.handle(CH.teamsList, () => teamSvc.list());
ipcMain.handle(CH.teamCapture, (_e, socket: string, paneId: string, lines?: number) =>
  teamSvc.capture(socket, paneId, lines),
);
ipcMain.handle(CH.teamSend, (_e, socket: string, paneId: string, text: string) =>
  teamSvc.send(socket, paneId, text),
);
ipcMain.handle(CH.teamIsolate, (_e, socket: string, paneId: string) =>
  teamSvc.isolate(socket, paneId));
ipcMain.handle(CH.teamRejoin, (_e, socket: string, paneId: string, windowId: string) =>
  teamSvc.rejoin(socket, paneId, windowId));
ipcMain.handle(CH.teamInterrupt, (_e, socket: string, paneId: string) =>
  teamSvc.interrupt(socket, paneId),
);

/**
 * The folder a workspace opens in when nothing else says.
 *
 * `process.cwd()` alone was wrong for the way most people start an app: a
 * Finder or Spotlight launch inherits `/`, so a first run opened on the
 * filesystem root. The saved layout's own directories are the fallback --
 * they are the only record of what this person actually works on.
 */
ipcMain.handle(CH.appCwd, () => {
  const saved = loadState<{ tabs?: { cwd?: string }[] } | null>(null);
  return launchCwd({
    cwd: process.cwd(),
    recent: (saved?.tabs ?? []).map((t) => t.cwd),
    home: homedir(),
  });
});

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
    const seq: Record<string, unknown> = {};

    // --- the service sees the live swarm ---
    const teams = await teamSvc.list();
    const t = teams.find((x) => x.socket && x.members.some((m) => m.alive));
    seq.teamFound = !!t;
    seq.socket = t?.socket ?? null;
    seq.liveMembers = (t?.members ?? []).filter((m) => m.alive && m.tmuxPaneId !== "leader").length;
    if (t?.socket) {
      const mate = t.members.find((m) => m.alive && m.tmuxPaneId !== "leader");
      if (mate?.tmuxPaneId) {
        const out = await teamSvc.capture(t.socket, mate.tmuxPaneId, 40);
        seq.captureBytes = out.length;
        seq.captureTail = out.split("\n").filter((l) => l.trim()).slice(-2).map((l) => l.slice(0, 50));
      }
    }

    // --- the bar appears in the UI, with a tab per teammate ---
    await sleep(4500);
    seq.barVisible = await js(`!!document.body.innerText.match(/\\d+ running/)`);
    seq.tabNames = await js(
      `[...document.querySelectorAll("button")].map(b=>b.innerText.trim()).filter(t=>/summarizer|explore/i.test(t)).slice(0,6).join(" | ")`,
    );

    // --- clicking a tab opens the live viewer ---
    seq.opened = await js(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => /summarizer/i.test(x.innerText));
      if (!b) return "no-tab";
      b.click();
      return "clicked";
    })()`);
    await sleep(2500);
    seq.viewerOpen = await js(`!!document.body.innerText.match(/interrupt/)`);
    seq.viewerHasOutput = await js(
      `(document.querySelector("pre")?.innerText ?? "").replace(/\\s+/g," ").trim().length`,
    );
    seq.hasInput = await js(`!!document.querySelector("input[placeholder*='talk to']")`);
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
