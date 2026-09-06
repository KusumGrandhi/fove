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
import { mkdir, readFile, readdir, writeFile, symlink, lstat, readlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
 * Finds env files *anywhere* in the tree, not just at the root. Checking only
 * the root got this wrong on the repository it was written for: `core/.env` is
 * 90 bytes, while the file that actually matters, `core/flask/.env`, is 19KB
 * and one directory down. A working worktree there links both.
 *
 * The test for "must be linked" is **untracked by git**:
 *
 *   - a *tracked* env file arrives with the worktree already, so linking it
 *     would fight git -- `core` tracks ten of them under `aiprise-frontend/`
 *     and `deployments/`, and a working worktree links none of them;
 *   - an *untracked* one exists only in the primary checkout, which is exactly
 *     what a fresh worktree is missing.
 *
 * `git ls-files` answers this directly. `check-ignore` does not: `core/.env`
 * is both tracked *and* matched by a gitignore rule, so an ignore-based test
 * gets it wrong in the one case that matters.
 *
 * Installed dependencies are proposed too, for a different reason. They are
 * not secrets — they are *expensive*: `core/aiprise-frontend/node_modules` is
 * 2.3GB, and reinstalling it per worktree costs minutes and disk for a byte-
 * identical result. A working worktree here links it, which is why a new one
 * is usable immediately.
 */
export async function suggestRecipe(repoRoot: string): Promise<Recipe> {
  const [envFiles, deps] = await Promise.all([
    findEnvFiles(repoRoot),
    findDepDirs(repoRoot),
  ]);
  if (envFiles.length === 0) return { link: deps.sort() };

  // One batched call listing which of these git tracks; the rest are ours.
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--", ...envFiles], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    const tracked = new Set(stdout.split("\u0000").filter(Boolean));
    return { link: [...envFiles.filter((f) => !tracked.has(f)), ...deps].sort() };
  } catch {
    // Not a git repository, or git unavailable: offer everything found and let
    // the user prune it rather than silently offering nothing.
    return { link: [...envFiles, ...deps].sort() };
  }
}

/** Dependency directories worth sharing rather than reinstalling. */
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor/bundle", ".yarn/cache"];

/**
 * Installed dependency directories, as repo-relative paths.
 *
 * Only real directories are proposed: one that is already a symlink belongs to
 * some other arrangement and should be left alone.
 */
async function findDepDirs(root: string, maxDepth = 2): Promise<string[]> {
  const out: string[] = [];

  const check = async (rel: string): Promise<void> => {
    try {
      const st = await lstat(join(root, rel));
      // A symlink here is somebody else's setup; a real directory is ours.
      if (st.isDirectory() && !st.isSymbolicLink()) out.push(rel);
    } catch {
      // Not installed here.
    }
  };

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    for (const name of DEP_DIRS) await check(rel ? `${rel}/${name}` : name);
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || DEP_DIRS.includes(entry.name)) continue;
      await walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };

  await walk(root, "", 0);
  return out;
}

/** Directories never worth walking for env files. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build",
  ".next", ".cache", "target", "vendor", ".mypy_cache", ".pytest_cache",
  // Tooling that parks whole checkouts inside the repo. Their env files belong
  // to those trees, not to a new worktree of this one.
  ".claude", ".conductor", ".warp", ".worktrees",
]);

/**
 * Env files in the tree, as repo-relative paths.
 *
 * Bounded on purpose: a few levels deep is enough to reach `flask/.env` or
 * `services/api/.env` without walking a monorepo's entire history of
 * dependencies.
 */
async function findEnvFiles(root: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), childRel, depth + 1);
      } else if (/^\.env(\..+)?$/.test(entry.name) || entry.name === ".envrc") {
        // `.env`, `.env.local`, `.env.production` -- but not `.env.example`,
        // which is committed documentation rather than real values.
        if (/\.(example|sample|template)$/i.test(entry.name)) continue;
        out.push(childRel);
      }
    }
  };

  await walk(root, "", 0);
  return out;
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
