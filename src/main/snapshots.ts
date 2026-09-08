/**
 * Working-tree snapshots, taken at turn boundaries.
 *
 * `changeset.ts` compares two snapshots; this produces them. Kept separate
 * because the comparison is the part with the interesting rules and deserves to
 * be provable without a git repository.
 *
 * Snapshots live in memory, keyed by worktree path. They are deliberately not
 * persisted: a snapshot is only meaningful against the session that produced
 * it, and a stale one restored from disk would attribute a week of edits to
 * whatever turn ran next.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { FileState, TreeSnapshot } from "../shared/changeset.js";

const run = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true });
  return stdout;
}

/** Run git with data on stdin. `execFile` cannot, and --stdin-paths needs it. */
function runWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let size = 0;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BUFFER) { child.kill(); reject(new Error("hash output too large")); return; }
      out += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
    child.stdin.on("error", reject); // a dead child makes this write throw
    child.stdin.end(input);
  });
}

/**
 * Hash every dirty file's *working tree* contents.
 *
 * Porcelain v2 already carries two hashes per entry, and neither is the one
 * needed here: `hH` is HEAD's blob and `hI` is the index's. For an unstaged
 * edit both are identical even though the file on disk differs -- **verified**,
 * not assumed -- so the free hashes cannot detect the case that matters most:
 * an already-dirty file edited again during a turn, where the status letter
 * stays "M" throughout.
 *
 * One batched `git hash-object` covers the whole list. Measured at **200 files
 * in 38ms**, which is cheap enough to run at every boundary.
 */
async function hashFiles(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  try {
    // --stdin-paths avoids an argv limit on a large change set, and git reads
    // this list newline-separated. `execFile` has no stdin, so this is spawned
    // directly and the input written to the pipe.
    const stdout = await runWithInput(cwd, ["hash-object", "--stdin-paths"], paths.join("\n") + "\n");
    const hashes = stdout.trim().split("\n").filter(Boolean);
    // A short read means some file could not be hashed; pairing by index would
    // then mislabel every file after it, so the whole batch is discarded and
    // the comparison falls back to status letters.
    if (hashes.length !== paths.length) return out;
    paths.forEach((p, i) => out.set(p, hashes[i]!));
  } catch {
    // A deleted file cannot be hashed and takes the batch down with it. The
    // comparison degrades to status letters, which is correct but coarser.
  }
  return out;
}

/**
 * Capture the current state of a working tree.
 *
 * Returns null when the path is not a git repository, which the caller should
 * treat as "no boundary available" rather than as an empty tree -- the two look
 * identical in a change set and mean opposite things.
 */
export async function takeSnapshot(cwd: string): Promise<TreeSnapshot | null> {
  let head: string | undefined;
  let statusOut: string;

  try {
    statusOut = await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  } catch {
    return null;
  }

  try {
    head = (await git(cwd, ["rev-parse", "HEAD"])).trim() || undefined;
  } catch {
    // A repository with no commits yet. Not an error, just no HEAD to compare.
  }

  const entries = parsePorcelain(statusOut);
  // Deletions cannot be hashed; asking would fail the whole batch.
  const hashable = entries.filter((e) => !e.status.includes("D")).map((e) => e.path);
  const hashes = await hashFiles(cwd, hashable);

  const files: FileState[] = entries.map((e) => ({
    path: e.path,
    status: e.status,
    hash: hashes.get(e.path),
  }));

  return { head, takenAt: Date.now(), files };
}

/**
 * Parse `git status --porcelain -z`.
 *
 * The short format rather than v2: this needs a path and a status letter, and
 * v2's extra fields are not usable here (see `hashFiles`). NUL-separated
 * because a path may contain anything, newlines included.
 *
 * A rename record carries two paths -- "R  new\0old" -- and the second entry is
 * consumed rather than treated as its own file.
 */
function parsePorcelain(out: string): { path: string; status: string }[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const entries: { path: string; status: string }[] = [];

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    // "XY <path>", where XY is exactly two columns.
    const status = rec.slice(0, 2).trim() || rec.slice(0, 2);
    const path = rec.slice(3);
    if (!path) continue;
    entries.push({ path, status });
    // A rename's old path follows as its own NUL-separated field.
    if (status.startsWith("R") || status.startsWith("C")) i++;
  }

  return entries;
}

/**
 * Snapshots held between a turn's start and its end.
 *
 * Keyed by worktree path, so a session in one worktree cannot contaminate
 * another -- the isolation the plan requires, enforced by the key rather than
 * by discipline at the call site.
 */
export class SnapshotStore {
  private readonly open = new Map<string, TreeSnapshot>();

  /** Record where a worktree stood as a turn begins. */
  async begin(cwd: string): Promise<TreeSnapshot | null> {
    const snap = await takeSnapshot(cwd);
    if (snap) this.open.set(cwd, snap);
    return snap;
  }

  /** The snapshot a turn started from, if one was taken. */
  opening(cwd: string): TreeSnapshot | null {
    return this.open.get(cwd) ?? null;
  }

  /**
   * Close a turn: the opening snapshot and a fresh one.
   *
   * Returns null when no opening snapshot exists -- fove was not watching when
   * the turn began, and a change set built against `now` would attribute every
   * uncommitted edit in the tree to this turn.
   */
  async end(cwd: string): Promise<{ before: TreeSnapshot; after: TreeSnapshot } | null> {
    const before = this.open.get(cwd);
    if (!before) return null;
    const after = await takeSnapshot(cwd);
    if (!after) return null;
    this.open.delete(cwd);
    return { before, after };
  }

  /** Drop a worktree's pending snapshot, e.g. when its workspace closes. */
  forget(cwd: string): void {
    this.open.delete(cwd);
  }
}
