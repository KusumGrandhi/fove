/**
 * Persisted app state (layout, pane kinds) under Electron's userData dir.
 * Writes are atomic so a crash mid-save cannot leave a truncated file that
 * would wipe the user's layout on next launch.
 */

import { app } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";

export function statePath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "workspace.json");
}

export function loadState<T>(fallback: T): T {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveState(state: unknown): void {
  const path = statePath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // Never let a failed save take the app down.
  }
}
