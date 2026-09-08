/**
 * Diffing a single commit, across the three shapes a commit can have.
 *
 * This is pinned rather than reviewed because the failure mode is silence.
 * `git diff <sha>^!` -- the obvious command, and the one this code used to
 * run for every commit -- exits 0 and prints *nothing* for both a root commit
 * and a merge. In the UI that renders as "this commit changed no files",
 * which is indistinguishable from an empty commit and wrong in both cases.
 *
 * All three behaviours were confirmed against real git before this was
 * written, not inferred from the documentation.
 *
 * Throwaway repositories only: these build their own history under a temp
 * directory and remove it after. Never point them at a real checkout.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/main/git.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

let dir: string;
const g = new GitService();

/** The sha of HEAD, which is what every test here needs. */
const head = async (): Promise<string> =>
  (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-commitdiff-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@t"]);
  await git(dir, ["config", "user.name", "Tester"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parentCount", () => {
  test("distinguishes root, ordinary and merge commits", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);
    const root = await head();
    expect(await g.parentCount(dir, root)).toBe(0);

    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await git(dir, ["commit", "-qam", "second"]);
    expect(await g.parentCount(dir, await head())).toBe(1);

    await git(dir, ["checkout", "-qb", "side", root]);
    await writeFile(join(dir, "b.txt"), "side\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "on side"]);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    expect(await g.parentCount(dir, await head())).toBe(2);
  });

  test("an unknown revision does not throw", async () => {
    // Best-effort: the caller only uses this to pick a diff strategy, and a
    // bad sha should degrade to the ordinary one rather than break the pane.
    expect(await g.parentCount(dir, "deadbeef")).toBe(1);
  });
});

describe("diff of one commit", () => {
  test("a root commit shows its files, not nothing", async () => {
    // The regression this exists for: `<sha>^!` gives an empty range here and
    // exits 0, so the pane would have said the first commit changed no files.
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);

    const files = await g.diff(dir, { commit: await head() });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("a.txt");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(0);
  });

  test("an ordinary commit shows only its own change", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await writeFile(join(dir, "b.txt"), "new\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "second"]);

    const files = await g.diff(dir, { commit: await head() });
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    // Not the whole file: the one line this commit added.
    expect(files.find((f) => f.path === "a.txt")!.additions).toBe(1);
  });

  test("a merge shows the change against its first parent", async () => {
    // The other silent-empty case: both `<sha>^!` and a bare `git show` print
    // nothing for a merge, because git's default there is a combined diff
    // that is suppressed unless the merge resolved a conflict.
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);
    const root = await head();

    await git(dir, ["checkout", "-qb", "side"]);
    await writeFile(join(dir, "side.txt"), "from the side\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "side work"]);

    await git(dir, ["checkout", "-q", "main", "--"]);
    await git(dir, ["checkout", "-q", root]);
    await git(dir, ["checkout", "-q", "-B", "main"]);
    await writeFile(join(dir, "main.txt"), "from main\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "main work"]);

    await git(dir, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);

    const files = await g.diff(dir, { commit: await head() });
    // What the side branch brought in -- and nothing from main's own history,
    // which is already in the first parent.
    expect(files.map((f) => f.path)).toEqual(["side.txt"]);
  });

  test("a commit that only deletes still reports the file", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    await writeFile(join(dir, "gone.txt"), "bye\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);
    await git(dir, ["rm", "-q", "gone.txt"]);
    await git(dir, ["commit", "-qm", "remove"]);

    const files = await g.diff(dir, { commit: await head() });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("gone.txt");
    expect(files[0]!.deletions).toBe(1);
  });

  test("an empty commit reports no files rather than failing", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "root"]);
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "nothing"]);

    // Genuinely empty, which the UI distinguishes from the cases above only
    // because those now return their files.
    expect(await g.diff(dir, { commit: await head() })).toEqual([]);
  });
});
