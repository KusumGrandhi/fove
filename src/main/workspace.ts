/**
 * Workspace recipes: make a fresh worktree usable without a manual checklist.
 *
 * A new worktree of `core` is not runnable until `.env` is in place, and doing
 * that by hand has already gone wrong on this machine — one worktree has a
 * symlink to the primary checkout's `.env`, another has a *copy*, which went
 * stale the moment the original changed and gives no sign that it did.
 *
 * So the rule here is **symlink, never copy**. A symlink cannot drift, and a
 * broken one is visibly broken rather than quietly wrong.
 *
 * Recipes live in `~/.config/fove/workspaces/<repo>.json`, outside the
 * repository: they name machine-local paths, and a file inside the repo would
 * eventually be committed.
 *
 * Nothing here overwrites an existing file. A `.env` with local edits is
 * exactly the file you cannot afford to clobber, so a conflict is reported and
 * skipped rather than resolved.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, symlink, lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const RECIPES_DIR = join(homedir(), ".config", "fove", "workspaces");

export interface Recipe {
  /** Paths symlinked from the primary checkout, e.g. [".env"]. */
  link?: string[];
  /** Commands run in the new worktree, in order. */
  run?: string[];
  /** Paths to open once it is ready. */
  open?: string[];
}

export interface StepResult {
  step: string;
  ok: boolean;
  /** Why it was skipped or failed -- shown verbatim. */
  detail?: string;
}

export interface SetupResult {
  ok: boolean;
  path: string;
  steps: StepResult[];
}

const recipePath = (repoRoot: string): string =>
  join(RECIPES_DIR, `${basename(repoRoot)}.json`);

/** The recipe for a repository, or null when it has none. */
export async function loadRecipe(repoRoot: string): Promise<Recipe | null> {
  try {
    const raw = JSON.parse(await readFile(recipePath(repoRoot), "utf8")) as Recipe;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export async function saveRecipe(repoRoot: string, recipe: Recipe): Promise<void> {
  await mkdir(RECIPES_DIR, { recursive: true });
  await writeFile(recipePath(repoRoot), JSON.stringify(recipe, null, 2) + "\n", { mode: 0o600 });
}

/**
 * A recipe inferred from what the primary checkout actually has.
 *
 * Offered as a starting point so the feature is useful before anything is
 * configured: the files named here are the ones that are present, gitignored,
 * and needed to run.
 */
export async function suggestRecipe(repoRoot: string): Promise<Recipe> {
  const candidates = [".env", ".env.local", ".env.development", ".envrc"];
  const link: string[] = [];
  for (const name of candidates) {
    try {
      await lstat(join(repoRoot, name));
      link.push(name);
    } catch {
      // Not present: nothing to link.
    }
  }
  return { link };
}

/** Reject a path that would escape the worktree. */
function insideWorktree(worktree: string, relative: string): string | null {
  if (isAbsolute(relative) || relative.includes("..")) return null;
  const full = resolve(worktree, relative);
  return full.startsWith(resolve(worktree)) ? full : null;
}

/**
 * Apply a recipe to a worktree.
 *
 * Every step is reported, including the skipped ones: "already had a .env" is
 * information the user needs, not noise to hide.
 */
export async function applyRecipe(
  worktree: string,
  primary: string,
  recipe: Recipe,
): Promise<SetupResult> {
  const steps: StepResult[] = [];

  for (const rel of recipe.link ?? []) {
    const target = insideWorktree(worktree, rel);
    if (!target) {
      steps.push({ step: `link ${rel}`, ok: false, detail: "path escapes the worktree" });
      continue;
    }
    const source = join(primary, rel);
    try {
      await lstat(source);
    } catch {
      steps.push({ step: `link ${rel}`, ok: false, detail: `no ${rel} in the primary checkout` });
      continue;
    }
    try {
      const existing = await lstat(target).catch(() => null);
      if (existing) {
        // An identical symlink is success; anything else is left alone.
        if (existing.isSymbolicLink() && (await readlink(target)) === source) {
          steps.push({ step: `link ${rel}`, ok: true, detail: "already linked" });
        } else {
          steps.push({
            step: `link ${rel}`,
            ok: false,
            detail: existing.isSymbolicLink()
              ? "a different symlink is already here"
              : "a real file is already here -- left untouched",
          });
        }
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await symlink(source, target);
      steps.push({ step: `link ${rel}`, ok: true });
    } catch (e) {
      steps.push({ step: `link ${rel}`, ok: false, detail: (e as Error).message });
    }
  }

  for (const command of recipe.run ?? []) {
    try {
      // A setup command is the user's own, but it should not be able to hang
      // the app forever.
      await run("/bin/sh", ["-lc", command], { cwd: worktree, timeout: 10 * 60_000 });
      steps.push({ step: command, ok: true });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      steps.push({ step: command, ok: false, detail: err.stderr || err.message });
    }
  }

  return { ok: steps.every((s) => s.ok), path: worktree, steps };
}

/**
 * Create a worktree and set it up.
 *
 * `git worktree add` is left to report its own failures -- "branch already
 * checked out" is the common one, and git says it better than a paraphrase.
 */
export async function createWorktree(opts: {
  repoRoot: string;
  path: string;
  branch: string;
  /** Create the branch rather than checking out an existing one. */
  newBranch?: boolean;
}): Promise<SetupResult> {
  const args = ["worktree", "add"];
  if (opts.newBranch) args.push("-b", opts.branch, opts.path);
  else args.push(opts.path, opts.branch);

  try {
    await run("git", args, { cwd: opts.repoRoot, timeout: 120_000 });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      ok: false,
      path: opts.path,
      steps: [{ step: `git worktree add`, ok: false, detail: err.stderr || err.message }],
    };
  }

  const created: StepResult = { step: `git worktree add ${opts.branch}`, ok: true };
  const recipe = (await loadRecipe(opts.repoRoot)) ?? (await suggestRecipe(opts.repoRoot));
  const applied = await applyRecipe(opts.path, opts.repoRoot, recipe);
  return { ok: applied.ok, path: opts.path, steps: [created, ...applied.steps] };
}
