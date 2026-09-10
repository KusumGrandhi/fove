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
import { GitWriteService } from "../src/main/gitWrite.js";
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
  const svc = new WorktreeService(new GitService(), new GitWriteService());

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

/**
 * Removal refuses before it acts.
 *
 * These run last and mutate the fixture, so `clean` is closed only in the test
 * that is meant to close it.
 */
describe("WorktreeService.remove", () => {
  const svc = new WorktreeService(new GitService(), new GitWriteService());

  it("refuses the main worktree", async () => {
    const r = await svc.remove(main, main);
    expect(r).toEqual({ ok: false, error: "cannot close the main worktree" });
  });

  it("refuses the worktree the request came from", async () => {
    const feat = join(root, "feat");
    const r = await svc.remove(feat, feat);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cannot close the worktree you are in");
  });

  it("refuses an unknown path", async () => {
    expect(await svc.remove(main, join(root, "nope"))).toEqual({ ok: false, error: "no such worktree" });
  });

  it("refuses to discard uncommitted work unless forced", async () => {
    const r = await svc.remove(main, join(root, "feat"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/uncommitted/);
    // The one refusal a retry can get past, and the only one flagged as such --
    // the UI offers to discard work on this and nothing else.
    expect(r.retryWithForce).toBe(true);
  });

  it("does not offer force on a refusal force cannot fix", async () => {
    expect((await svc.remove(main, main)).retryWithForce).toBeUndefined();
    expect((await svc.remove(main, join(root, "nope"))).retryWithForce).toBeUndefined();
  });

  it("closes a clean worktree and leaves its branch behind", async () => {
    expect(await svc.remove(main, join(root, "clean"))).toEqual({ ok: true });
    const list = await svc.list(main);
    expect(list.map((w) => w.name).sort()).toEqual(["feat", "main"]);
    // Closing a checkout is not deleting the work on it.
    const { stdout } = await run("git", ["branch", "--list", "clean-branch"], { cwd: main });
    expect(stdout.trim()).toContain("clean-branch");
  });

  it("closes a dirty worktree when forced", async () => {
    expect(await svc.remove(main, join(root, "feat"), { force: true })).toEqual({ ok: true });
    expect((await svc.list(main)).map((w) => w.name)).toEqual(["main"]);
  });
});
