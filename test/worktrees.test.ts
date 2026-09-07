/**
 * WorktreeService against a real repository.
 *
 * The pure join is tested separately; this covers the part that talks to git,
 * because every significant bug in v0.5 passed its unit tests and appeared only
 * when something real was on the other end.
 *
 * The fixture is disposable and created per run -- never a real repository.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "../src/main/git.js";
import { WorktreeService } from "../src/main/worktrees.js";

const run = promisify(execFile);

let root = "";
let main = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fove-wt-"));
  main = join(root, "main");
  const git = (cwd: string, args: string[]) => run("git", args, { cwd });

  await run("git", ["init", "-q", "main"], { cwd: root });
  await git(main, ["config", "user.email", "t@example.com"]);
  await git(main, ["config", "user.name", "Test"]);
  await writeFile(join(main, "a.txt"), "hi\n");
  await git(main, ["add", "-A"]);
  await git(main, ["commit", "-qm", "first"]);
  await git(main, ["worktree", "add", "-q", join(root, "feat"), "-b", "feature"]);
  await git(main, ["worktree", "add", "-q", join(root, "clean"), "-b", "clean-branch"]);

  // Two kinds of dirt in the main checkout, one staged file in `feat`.
  await writeFile(join(main, "a.txt"), "hi\nchanged\n");
  await writeFile(join(main, "untracked.txt"), "new\n");
  await writeFile(join(root, "feat", "b.txt"), "x\n");
  await git(join(root, "feat"), ["add", "b.txt"]);
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("WorktreeService", () => {
  const svc = new WorktreeService(new GitService());

  it("lists every worktree of the repository", async () => {
    const list = await svc.list(main);
    expect(list.map((w) => w.branch).sort()).toEqual(["clean-branch", "feature", "main"]);
  });

  it("counts staged and unstaged changes, and untracked files", async () => {
    const list = await svc.list(main);
    // a.txt modified + untracked.txt.
    expect(list.find((w) => w.branch === "main")!.dirty).toBe(2);
    // Staged counts as dirty: it is uncommitted work either way.
    expect(list.find((w) => w.branch === "feature")!.dirty).toBe(1);
    expect(list.find((w) => w.branch === "clean-branch")!.dirty).toBe(0);
  });

  it("marks the worktree the request came from", async () => {
    const list = await svc.list(main);
    expect(list.filter((w) => w.current).map((w) => w.branch)).toEqual(["main"]);
  });

  it("marks the right worktree as current when asked from another one", async () => {
    const list = await svc.list(join(root, "feat"));
    expect(list.filter((w) => w.current).map((w) => w.branch)).toEqual(["feature"]);
  });

  it("names each worktree by its directory", async () => {
    const list = await svc.list(main);
    expect(list.map((w) => w.name).sort()).toEqual(["clean", "feat", "main"]);
  });

  it("reports no agents when nothing is running in the fixture", async () => {
    const list = await svc.list(main);
    expect(list.every((w) => w.agents === 0)).toBe(true);
  });

  it("returns an empty list outside a repository", async () => {
    expect(await svc.list(tmpdir())).toEqual([]);
  });
});
