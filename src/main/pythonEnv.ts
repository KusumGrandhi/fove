/**
 * Which Python a project uses, remembered.
 *
 * Nothing on disk can tell you this. A repository that uses conda says so
 * nowhere -- `core` has no pyrightconfig, no pyproject, and its README
 * describes a venv the author stopped using -- so any answer fove works out by
 * itself is a guess. Guessing badly is not harmless: two conda environments
 * differing only by Python version resolve every third-party import to a
 * different `site-packages`, and go-to-definition lands you in the wrong copy
 * of Flask without ever saying so.
 *
 * So the choice is the user's, made once per project and kept. Auto-detection
 * stays as the default for a project nobody has chosen for, which is most of
 * them.
 *
 * Deliberately not stored in the repository: an interpreter path is a fact
 * about this machine, and committing one would break every teammate whose
 * environment lives somewhere else.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Beside the other per-machine fove settings, never inside a project. */
export const ENV_PATH = join(homedir(), ".config", "fove", "python.json");

/** Absolute project root -> absolute interpreter path. */
type EnvFile = Record<string, string>;

let cache: EnvFile | null = null;
let path = ENV_PATH;

/** Tests point the store at a scratch file; passing null restores the default. */
export function setStorePath(p: string | null): void {
  path = p ?? ENV_PATH;
  cache = null;
}

function load(): EnvFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as EnvFile) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** The interpreter chosen for this project, or null if nobody has chosen one. */
export function chosenInterpreter(root: string): string | null {
  return load()[root] ?? null;
}

/**
 * Remember an interpreter for a project, or forget it when given null.
 *
 * Written atomically, same as the layout store: a crash mid-write must not
 * leave a truncated file that loses every project's choice.
 */
export function chooseInterpreter(root: string, interpreter: string | null): void {
  const all = { ...load() };
  if (interpreter) all[root] = interpreter;
  else delete all[root];
  cache = all;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // A choice that cannot be written is still honoured for this session.
  }
}
