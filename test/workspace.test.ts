/**
 * Workspace recipes, against throwaway repositories.
 *
 * These create worktrees and symlinks; never point them at a real checkout.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, lstat, readlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRecipe, createWorktree, suggestRecipe } from "../src/main/workspace.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

let repo: string;
let scratch: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "fove-ws-"));
  scratch = await mkdtemp(join(tmpdir(), "fove-wt-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
  await writeFile(join(repo, "readme.md"), "hi\n");
  await writeFile(join(repo, ".env"), "SECRET=1\n");
  await writeFile(join(repo, ".gitignore"), ".env\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "first"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("suggestRecipe", () => {
  test("offers an untracked env file", async () => {
    const r = await suggestRecipe(repo);
    expect(r.link).toContain(".env");
  });

  test("finds env files below the root, not just in it", async () => {
    // The case this was written for: core/.env is 90 bytes of PYTHONPATH while
    // core/flask/.env is the 19KB file that actually matters.
    await mkdir(join(repo, "flask"), { recursive: true });
    await writeFile(join(repo, "flask", ".env"), "DATABASE_URL=real\n");
    const r = await suggestRecipe(repo);
    expect(r.link).toContain("flask/.env");
  });

  test("skips env files git already tracks", async () => {
    // A tracked file arrives with the worktree, so linking it fights git.
    await mkdir(join(repo, "frontend"), { recursive: true });
    await writeFile(join(repo, "frontend", ".env.production"), "API=1\n");
    await git(repo, ["add", "-f", "frontend/.env.production"]);
    await git(repo, ["commit", "-qm", "track prod env"]);

    const r = await suggestRecipe(repo);
    expect(r.link).not.toContain("frontend/.env.production");
  });

  test("skips .env.example, which is committed documentation", async () => {
    await writeFile(join(repo, ".env.example"), "SECRET=replace-me\n");
    const r = await suggestRecipe(repo);
    expect(r.link).not.toContain(".env.example");
  });

  test("does not walk into a nested checkout's own env", async () => {
    await mkdir(join(repo, ".conductor", "other"), { recursive: true });
    await writeFile(join(repo, ".conductor", "other", ".env"), "NOT=mine\n");
    const r = await suggestRecipe(repo);
    expect(r.link!.some((p) => p.startsWith(".conductor/"))).toBe(false);
  });

  test("ignores dependency directories", async () => {
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", ".env"), "X=1\n");
    const r = await suggestRecipe(repo);
    expect(r.link!.some((p) => p.includes("node_modules"))).toBe(false);
  });
});

describe("applyRecipe", () => {
  test("symlinks rather than copying, so it cannot go stale", async () => {
    const wt = join(scratch, "w1");
    await mkdir(wt);
    const res = await applyRecipe(wt, repo, { link: [".env"] });
    expect(res.ok).toBe(true);

    const st = await lstat(join(wt, ".env"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await readlink(join(wt, ".env"))).toBe(join(repo, ".env"));

    // The point of a link: the source changing is reflected immediately.
    await writeFile(join(repo, ".env"), "SECRET=2\n");
    expect(await readFile(join(wt, ".env"), "utf8")).toBe("SECRET=2\n");
  });

  test("never overwrites a real file that is already there", async () => {
    const wt = join(scratch, "w2");
    await mkdir(wt);
    await writeFile(join(wt, ".env"), "LOCAL=keep\n");
    const res = await applyRecipe(wt, repo, { link: [".env"] });
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain("left untouched");
    // The local edits survive.
    expect(await readFile(join(wt, ".env"), "utf8")).toBe("LOCAL=keep\n");
  });

  test("an already-correct link is success, not a conflict", async () => {
    const wt = join(scratch, "w3");
    await mkdir(wt);
    await applyRecipe(wt, repo, { link: [".env"] });
    const again = await applyRecipe(wt, repo, { link: [".env"] });
    expect(again.ok).toBe(true);
    expect(again.steps[0]!.detail).toBe("already linked");
  });

  test("a missing source is reported, not silently skipped", async () => {
    const wt = join(scratch, "w4");
    await mkdir(wt);
    const res = await applyRecipe(wt, repo, { link: [".env.nope"] });
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain("primary checkout");
  });

  test("a path escaping the worktree is refused", async () => {
    const wt = join(scratch, "w5");
    await mkdir(wt);
    const res = await applyRecipe(wt, repo, { link: ["../escape"] });
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain("escapes");
  });

  test("runs setup commands in the worktree", async () => {
    const wt = join(scratch, "w6");
    await mkdir(wt);
    const res = await applyRecipe(wt, repo, { run: ["echo ran > marker.txt"] });
    expect(res.ok).toBe(true);
    expect(await readFile(join(wt, "marker.txt"), "utf8")).toContain("ran");
  });

  test("a failing command reports its own stderr", async () => {
    const wt = join(scratch, "w7");
    await mkdir(wt);
    const res = await applyRecipe(wt, repo, { run: ["echo boom >&2; exit 3"] });
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain("boom");
  });
});

describe("createWorktree", () => {
  test("creates a branch, checks it out, and applies the recipe", async () => {
    const wt = join(scratch, "feature");
    const res = await createWorktree({
      repoRoot: repo, path: wt, branch: "feature", newBranch: true,
    });
    expect(res.ok).toBe(true);
    // The worktree is real...
    expect(await readFile(join(wt, "readme.md"), "utf8")).toBe("hi\n");
    // ...and .env came across as a link, from the inferred recipe.
    expect((await lstat(join(wt, ".env"))).isSymbolicLink()).toBe(true);
  });

  test("git's own error survives when the branch is taken", async () => {
    const res = await createWorktree({
      repoRoot: repo, path: join(scratch, "dup"), branch: "main",
    });
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail ?? "").toMatch(/already (checked out|used)/i);
  });
});
