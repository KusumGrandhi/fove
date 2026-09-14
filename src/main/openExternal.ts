/**
 * The "easy path": hand a file to the editor the user already trusts.
 *
 * This ships long before an in-app editor and stays afterwards -- jumping to
 * VS Code at an exact line is often what you actually want, and it means the
 * app is useful before it is complete.
 */

import { execFile } from "node:child_process";
import { shell } from "electron";
import { ensureToolPath } from "./loginPath.js";

/**
 * Open `file` in VS Code at `line`. Falls back to the OS default handler when
 * the `code` CLI is not on PATH, so this never dead-ends.
 */
export function openInEditor(file: string, line?: number, column = 1): void {
  const target = line ? `${file}:${line}:${column}` : file;
  // `code` is installed into /usr/local/bin by VS Code itself, which a
  // GUI-launched app has no PATH entry for -- so without this the packaged
  // app always fell through to "open with the default handler", quietly
  // ignoring the line number it was asked to jump to.
  void ensureToolPath().then(() => {
    execFile("code", ["--goto", target], { windowsHide: true }, (err) => {
      if (err) void shell.openPath(file);
    });
  });
}

export function revealInFinder(file: string): void {
  shell.showItemInFolder(file);
}
