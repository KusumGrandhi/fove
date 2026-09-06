/**
 * The ONLY file this app writes: ~/.claude/settings.json.
 *
 * Small, documented, user-owned. Writes are atomic (temp file + rename) so a
 * crash mid-write cannot truncate the user's settings, preserve the existing
 * file mode, and take a one-time timestamped backup per session.
 *
 * Unknown keys are preserved: we parse, mutate one key, and re-serialise, so a
 * setting this app does not model survives a round trip.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { chmod, copyFile, rename, stat, writeFile, readFile } from "node:fs/promises";

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export type SkillOverride = "on" | "off" | "name-only" | "user-invocable-only";

export interface Settings {
  skillOverrides?: Record<string, SkillOverride>;
  [k: string]: unknown;
}

export async function readSettings(path = SETTINGS_PATH): Promise<Settings> {
  try {
    const v = JSON.parse(await readFile(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : {};
  } catch {
    return {};
  }
}

const backedUp = new Set<string>();

/**
 * Write settings atomically, preserving mode and unknown keys.
 * Takes one backup per path per process, before the first modification.
 */
export async function writeSettings(next: Settings, path = SETTINGS_PATH): Promise<void> {
  let mode = 0o600;
  let exists = true;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    exists = false;
  }

  if (exists && !backedUp.has(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(path, `${path}.${stamp}.bak`).catch(() => {});
    backedUp.add(path);
  }

  const tmp = join(dirname(path), `.settings.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path); // atomic within a filesystem
}

/**
 * Set or clear one skill's override.
 *
 * "on" removes the entry rather than storing it: absent is the default, and a
 * smaller settings file is easier for a human to read.
 */
export async function setSkillOverride(
  name: string,
  state: SkillOverride,
  path = SETTINGS_PATH,
): Promise<Settings> {
  const settings = await readSettings(path);
  const overrides = { ...(settings.skillOverrides ?? {}) };
  if (state === "on") delete overrides[name];
  else overrides[name] = state;

  const next: Settings = { ...settings };
  if (Object.keys(overrides).length) next.skillOverrides = overrides;
  else delete next.skillOverrides;

  await writeSettings(next, path);
  return next;
}

/** Cycle a skill through the three useful states. */
export function nextOverride(current: SkillOverride | undefined): SkillOverride {
  return current === undefined || current === "on"
    ? "user-invocable-only"
    : current === "user-invocable-only"
      ? "off"
      : "on";
}
