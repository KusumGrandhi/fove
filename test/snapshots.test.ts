/**
 * Working-tree snapshots, against real git.
 *
 * `changeset.test.ts` proves the comparison rules on hand-built data. This
 * proves the part that can only be wrong against a real repository: that the
 * snapshot actually notices what git reports, and in particular that it
 * catches an already-dirty file edited again -- the case porcelain's own
 * hashes cannot see, and the reason `hash-object` is run at all.
 *
 * Throwaway repositories only. Never point these at a real checkout.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot, SnapshotStore } from "../src/main/snapshots.js";
import { compareSnapshots } from "../src/shared/changeset.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-snap-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@t"]);
  await git(dir, ["config", "user.name", "Tester"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "first"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  test("a clean tree has no files but does have a HEAD", async () => {
    const snap = (await takeSnapshot(dir))!;
    expect(snap.files).toEqual([]);
    expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns null outside a repository", async () => {
    // Distinct from an empty tree: the two look identical in a change set and
    // mean opposite things, so the caller must be able to tell them apart.
    const plain = await mkdtemp(join(tmpdir(), "fove-nogit-"));
    try {
      expect(await takeSnapshot(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("sees modified, untracked and deleted files", async () => {
    await writeFile(join(dir, "a.txt"), "changed\n");
    await writeFile(join(dir, "new.txt"), "new\n");
    await writeFile(join(dir, "gone.txt"), "x\n");
    await git(dir, ["add", "gone.txt"]);
    await git(dir, ["commit", "-qm", "add gone"]);
    await rm(join(dir, "gone.txt"));

    const snap = (await takeSnapshot(dir))!;
    const paths = snap.files.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", "gone.txt", "new.txt"]);
  });

  test("hashes the working tree, not the index", async () => {
    // The property the whole module exists for. Porcelain's own hashes are
    // HEAD's and the index's, which are identical for an unstaged edit.
    await writeFile(join(dir, "a.txt"), "edited\n");
    const first = (await takeSnapshot(dir))!;
    await writeFile(join(dir, "a.txt"), "edited again\n");
    const second = (await takeSnapshot(dir))!;

    const h1 = first.files.find((f) => f.path === "a.txt")!.hash;
    const h2 = second.files.find((f) => f.path === "a.txt")!.hash;
    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h1).not.toBe(h2);
  });

  test("a deleted file does not break hashing for the rest", async () => {
    // `hash-object` fails on a missing path and would take the batch with it,
    // so deletions are excluded before the call.
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "add b"]);
    await rm(join(dir, "a.txt"));
    await writeFile(join(dir, "b.txt"), "changed\n");

    const snap = (await takeSnapshot(dir))!;
    expect(snap.files.find((f) => f.path === "b.txt")!.hash).toBeDefined();
  });

  test("handles a path with a space", async () => {
    // -z is used precisely so a path may contain anything.
    await mkdir(join(dir, "a dir"), { recursive: true });
    await writeFile(join(dir, "a dir", "a file.txt"), "x\n");
    const snap = (await takeSnapshot(dir))!;
    expect(snap.files.map((f) => f.path)).toContain("a dir/a file.txt");
  });

  test("a rename is one file, not two", async () => {
    await git(dir, ["mv", "a.txt", "renamed.txt"]);
    const snap = (await takeSnapshot(dir))!;
    // The old path follows the new one as its own NUL field and must be
    // consumed rather than becoming a phantom entry.
    expect(snap.files).toHaveLength(1);
  });
});

describe("SnapshotStore, end to end against git", () => {
  test("reports only what changed inside the window", async () => {
    // The whole point: a file dirty before the turn started is not the turn's
    // doing, and must not appear in its change set.
    await writeFile(join(dir, "a.txt"), "dirty before the turn\n");

    const store = new SnapshotStore();
    await store.begin(dir);

    await writeFile(join(dir, "during.txt"), "written during\n");

    const pair = (await store.end(dir))!;
    const set = compareSnapshots(pair.before, pair.after);

    expect(set.changed.map((c) => c.path)).toEqual(["during.txt"]);
    expect(set.carried.map((c) => c.path)).toEqual(["a.txt"]);
  });

  test("catches a second edit to an already-dirty file", async () => {
    await writeFile(join(dir, "a.txt"), "first edit\n");

    const store = new SnapshotStore();
    await store.begin(dir);
    await writeFile(join(dir, "a.txt"), "second edit\n");

    const pair = (await store.end(dir))!;
    const set = compareSnapshots(pair.before, pair.after);

    // Status is "M" in both snapshots; only the content hash reveals this.
    expect(set.changed).toHaveLength(1);
    expect(set.changed[0]).toMatchObject({ path: "a.txt", kind: "modified", preexisting: true });
  });

  test("notices a commit made during the turn", async () => {
    const store = new SnapshotStore();
    await store.begin(dir);
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "during"]);

    const pair = (await store.end(dir))!;
    expect(compareSnapshots(pair.before, pair.after).committed).toBe(true);
  });

  test("returns null when no turn was opened", async () => {
    // Without an opening snapshot a change set would be built against `now`
    // and would attribute every uncommitted edit in the tree to this turn.
    expect(await new SnapshotStore().end(dir)).toBeNull();
  });

  test("keeps worktrees apart", async () => {
    // A session in one worktree must not contaminate another; the store is
    // keyed by path so this is enforced rather than merely intended.
    const other = await mkdtemp(join(tmpdir(), "fove-snap2-"));
    try {
      await git(other, ["init", "-q", "-b", "main"]);
      await git(other, ["config", "user.email", "t@t"]);
      await git(other, ["config", "user.name", "T"]);
      await writeFile(join(other, "x.txt"), "x\n");
      await git(other, ["add", "-A"]);
      await git(other, ["commit", "-qm", "base"]);

      const store = new SnapshotStore();
      await store.begin(dir);
      await store.begin(other);

      await writeFile(join(dir, "here.txt"), "here\n");
      await writeFile(join(other, "there.txt"), "there\n");

      const a = compareSnapshots(...Object.values((await store.end(dir))!) as [never, never]);
      const b = compareSnapshots(...Object.values((await store.end(other))!) as [never, never]);

      expect(a.changed.map((c) => c.path)).toEqual(["here.txt"]);
      expect(b.changed.map((c) => c.path)).toEqual(["there.txt"]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("forget drops a pending snapshot", async () => {
    const store = new SnapshotStore();
    await store.begin(dir);
    store.forget(dir);
    expect(store.opening(dir)).toBeNull();
    expect(await store.end(dir)).toBeNull();
  });
});
