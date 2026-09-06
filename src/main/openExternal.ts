/**
 * The "easy path": hand a file to the editor the user already trusts.
 *
 * This ships long before an in-app editor and stays afterwards -- jumping to
 * VS Code at an exact line is often what you actually want, and it means the
 * app is useful before it is complete.
 */

import { execFile } from "node:child_process";
import { shell } from "electron";

/**
 * Open `file` in VS Code at `line`. Falls back to the OS default handler when
 * the `code` CLI is not on PATH, so this never dead-ends.
 */
export function openInEditor(file: string, line?: number, column = 1): void {
  const target = line ? `${file}:${line}:${column}` : file;
  execFile("code", ["--goto", target], { windowsHide: true }, (err) => {
    if (err) void shell.openPath(file);
  });
}

export function revealInFinder(file: string): void {
  shell.showItemInFolder(file);
}
