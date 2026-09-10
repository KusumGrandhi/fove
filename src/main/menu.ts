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
import { check, install } from "./doctor.js";
import { DEPS, report, summary, installCommand } from "../shared/deps.js";

/**
 * Run the check and show the result as a native dialog.
 *
 * A dialog rather than a window: there is nothing to interact with beyond a
 * decision, it must work before the renderer is trustworthy, and it should not
 * become a place people keep open.
 */
async function showSetupCheck(parent: BrowserWindow | null): Promise<void> {
  const reports = report(await check());
  const missing = reports.filter((r) => !r.found);

  const lines = reports.map((r) => {
    const mark = r.found ? "✓" : r.dep.severity === "required" ? "✗" : "!";
    const detail = r.found
      ? (r.status.version ?? r.status.path ?? "")
      : r.dep.needs;
    return `${mark}  ${r.dep.label} — ${detail}`;
  });

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
  const failures: string[] = [];
  for (const bin of bins) {
    const r = await install(bin);
    if (!r.ok) failures.push(`${bin}: ${r.output.split("\n").slice(-3).join(" ")}`);
  }

  const after = report(await check());
  const stillMissing = after.filter((r) => bins.includes(r.dep.bin) && !r.found);

  const opts = {
    type: stillMissing.length === 0 ? ("info" as const) : ("error" as const),
    title: "fove — Setup Check",
    message: stillMissing.length === 0
      ? "Installed."
      : `Still missing: ${stillMissing.map((r) => r.dep.label).join(", ")}`,
    detail: failures.length > 0 ? failures.join("\n\n") : undefined,
    buttons: ["OK"],
    noLink: true,
  };
  if (parent) await dialog.showMessageBox(parent, opts);
  else await dialog.showMessageBox(opts);
}

/** Build and install the application menu. */
export function installMenu(getWindow: () => BrowserWindow | null): void {
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
