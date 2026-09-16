/**
 * The macOS menu bar.
 *
 * Electron's default menu is fine for the standard items, so this rebuilds it
 * rather than replacing it wholesale: the app, Edit, View and Window menus are
 * the usual ones, and File gains the things that belong to fove but not to any
 * pane.
 *
 * Setup Check lives here rather than in the app's own UI on purpose. Whether
 * `tmux` is installed is a fact about the machine, not project configuration,
 * and a pane is the wrong place to answer it -- the answer is also most needed
 * on a fresh install, when the panes that depend on those tools are exactly
 * the ones that will not work.
 */

import { app, BrowserWindow, Menu, dialog, shell, clipboard } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { check, install, pythonEnvs } from "./doctor.js";
import { DEPS, report, summary, installCommand } from "../shared/deps.js";
import { loadState } from "./store.js";

/**
 * The projects this person has open, from the layout the app already saves.
 *
 * The setup sheet is a main-process dialog with no renderer to ask, and the
 * saved layout is the only record of what someone actually works on -- which
 * is what makes a per-project check possible here at all.
 */
function projectRoots(): string[] {
  const saved = loadState<{ tabs?: { cwd?: string }[] } | null>(null);
  return (saved?.tabs ?? []).map((t) => t.cwd).filter((c): c is string => !!c);
}

/**
 * Told to whoever caches "this machine has no language server for X".
 *
 * The menu is built once and lives for the process, so the hook is a module
 * variable rather than threaded through every function that might need it.
 */
let forgetProbes: () => void = () => {};

/**
 * Run the check and show the result as a native dialog.
 *
 * A dialog rather than a window: there is nothing to interact with beyond a
 * decision, it must work before the renderer is trustworthy, and it should not
 * become a place people keep open.
 */
async function showSetupCheck(parent: BrowserWindow | null): Promise<void> {
  const [reports, envs] = await Promise.all([
    check().then(report),
    pythonEnvs(projectRoots()),
  ]);
  const missing = reports.filter((r) => !r.found);

  const lines = reports.map((r) => {
    const mark = r.found ? "✓" : r.dep.severity === "required" ? "✗" : "!";
    const detail = r.found
      ? (r.status.version ?? r.status.path ?? "")
      : r.dep.needs;
    return `${mark}  ${r.dep.label} — ${detail}`;
  });

  /*
   * Which Python each project resolves to.
   *
   * "Pyright ✓" was true on a machine where Python go-to-definition did
   * nothing for any third-party import, because the server was running with no
   * environment at all. A check that reports the tool but not the thing the
   * tool needs is how a setup sheet lies while every row is accurate.
   */
  if (envs.length > 0) {
    lines.push("");
    for (const e of envs) {
      const name = e.root.split("/").pop() || e.root;
      if (!e.path) {
        lines.push(`!  Python · ${name} — none found; only stdlib and this project's own code will resolve`);
        continue;
      }
      const where = e.path.includes("/envs/")
        ? `conda: ${e.path.split("/envs/")[1]!.split("/")[0]}`
        : e.path;
      lines.push(`✓  Python · ${name} — ${where}${e.version ? ` (${e.version})` : ""}${e.chosen ? "" : ", detected"}`);
    }
    lines.push("Wrong one? Pick it in a Debugger pane; the choice is kept per project.");
  }

  // Only offer to install what brew can actually install.
  const installable = missing.filter((r) => installCommand(r.dep));
  const buttons = ["OK"];
  if (installable.length > 0) {
    buttons.push(`Install ${installable.map((r) => r.dep.label).join(", ")}`);
  }
  if (missing.some((r) => r.dep.url)) buttons.push("Copy install commands");

  const opts = {
    type: missing.length === 0 ? ("info" as const) : ("warning" as const),
    title: "fove — Setup Check",
    message: summary(reports) ?? "Everything fove needs is installed.",
    /*
     * The list, and nothing else.
     *
     * An NSAlert is narrow and wraps hard, so a paragraph of explanation here
     * reads as a wall rather than as prose -- the rows already say what is
     * missing and what it costs, and anything longer belongs in the README.
     */
    detail: lines.join("\n"),
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };

  const { response } = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);

  const chosen = buttons[response];
  if (chosen?.startsWith("Install ")) {
    await runInstalls(parent, installable.map((r) => r.dep.bin));
  } else if (chosen === "Copy install commands") {
    // Everything needed to fix the machine by hand, in one paste.
    const cmds = missing.map((r) => installCommand(r.dep) ?? `# ${r.dep.label}: ${r.dep.url}`);
    clipboard.writeText(cmds.join("\n"));
  }
}

/**
 * Install each missing dependency, then report what actually changed.
 *
 * The result is re-checked rather than taken from brew's exit code: brew can
 * succeed at installing something that is still not on this PATH, and the
 * dialog should say what is true now.
 */
async function runInstalls(parent: BrowserWindow | null, bins: string[]): Promise<void> {
  /*
   * Say that something is happening.
   *
   * `brew install` takes tens of seconds at best and minutes at worst, and
   * until this the app showed *nothing at all* for the whole of it -- the
   * dialog closed, and then fove sat there. Clicking Install and watching
   * nothing happen is indistinguishable from a button that does not work,
   * which is exactly how it was reported.
   *
   * An indeterminate dock progress bar is the honest signal: it says "still
   * going" without claiming to know how far along it is.
   */
  parent?.setProgressBar(2);

  const failures: string[] = [];
  try {
    for (const bin of bins) {
      const r = await install(bin);
      if (!r.ok) failures.push(`${bin}\n${r.output}`);
    }
  } finally {
    parent?.setProgressBar(-1);
  }

  const after = report(await check());
  const installed = after.filter((r) => bins.includes(r.dep.bin) && r.found);
  const stillMissing = after.filter((r) => bins.includes(r.dep.bin) && !r.found);

  // A language server the editor already gave up looking for this session.
  // Without this the app would install pyright for you and then keep behaving
  // exactly as if you had none.
  if (installed.length > 0) forgetProbes();

  const needsRestart = installed.some((r) => r.dep.bin.includes("langserver") || r.dep.bin.includes("language-server"));

  const opts = {
    type: stillMissing.length === 0 ? ("info" as const) : ("error" as const),
    title: "fove — Setup Check",
    message: stillMissing.length === 0
      ? "Installed."
      : `Still missing: ${stillMissing.map((r) => r.dep.label).join(", ")}`,
    detail: [
      failures.length > 0 ? failures.join("\n\n") : "",
      // Editors already open asked for a language server once and were told
      // there was none; they do not ask again.
      needsRestart && stillMissing.length === 0
        ? "Reopen the file, or restart fove, for editors already open to use it."
        : "",
    ].filter(Boolean).join("\n\n") || undefined,
    buttons: ["OK"],
    noLink: true,
  };
  if (parent) await dialog.showMessageBox(parent, opts);
  else await dialog.showMessageBox(opts);
}

/**
 * Build and install the application menu.
 *
 * `onDepsInstalled` is called after the Setup Check sheet actually puts a tool
 * on the machine, so anything that concluded the tool was absent can stop
 * believing that.
 */
export function installMenu(
  getWindow: () => BrowserWindow | null,
  onDepsInstalled: () => void = () => {},
): void {
  forgetProbes = onDepsInstalled;
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" as const },
            { type: "separator" as const },
            { role: "services" as const },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { role: "unhide" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Setup Check…",
          // No accelerator: it is a once-in-a-while action, and every letter
          // worth binding is already doing something in the app itself.
          click: () => void showSetupCheck(getWindow()),
        },
        { type: "separator" },
        {
          label: "Open Setup Script in Terminal…",
          // The script does what the dialog does, plus the build -- useful on
          // a machine where the app is not installed yet, so it is offered as
          // a path to copy rather than something run for you.
          click: () => {
            clipboard.writeText("./scripts/bootstrap.sh");
            void dialog.showMessageBox({
              type: "info",
              title: "fove — Setup Script",
              message: "Copied: ./scripts/bootstrap.sh",
              detail:
                "Run it from the fove repository. It checks every tool, installs\n" +
                "what Homebrew can, builds the app and installs it to /Applications.\n" +
                "Add --check to report without changing anything.",
              buttons: ["OK"],
              noLink: true,
            });
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "What fove needs installed",
          click: () => {
            const url = DEPS.find((d) => d.bin === "claude")?.url;
            if (url) void shell.openExternal(url);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
