/**
 * Git write operations, exercised against a throwaway repository.
 *
 * Never point these at a real checkout: they stage, commit, stash and discard.
 * Every test builds its own repo under a temp directory and removes it after.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWriteService } from "../src/main/gitWrite.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

let dir: string;
const g = new GitWriteService();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-git-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@t"]);
  await git(dir, ["config", "user.name", "Tester"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "first"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("staging", () => {
  test("stage then unstage leaves the working tree alone", async () => {
    await writeFile(join(dir, "a.txt"), "one\nCHANGED\nthree\n");
    expect((await g.stage(dir, ["a.txt"])).ok).toBe(true);
    expect((await git(dir, ["diff", "--cached", "--name-only"])).stdout).toContain("a.txt");

    expect((await g.unstage(dir, ["a.txt"])).ok).toBe(true);
    expect((await git(dir, ["diff", "--cached", "--name-only"])).stdout).not.toContain("a.txt");
    // The edit itself survives -- unstaging is not discarding.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toContain("CHANGED");
  });

  test("unstage works before the first commit, where `reset HEAD` would fail", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "fove-git-empty-"));
    try {
      await git(fresh, ["init", "-q", "-b", "main"]);
      await writeFile(join(fresh, "new.txt"), "hi\n");
      await g.stage(fresh, ["new.txt"]);
      expect((await g.unstage(fresh, ["new.txt"])).ok).toBe(true);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test("staging nothing is a no-op, not an error", async () => {
    expect((await g.stage(dir, [])).ok).toBe(true);
  });

  test("a path that looks like a flag is treated as a path", async () => {
    await writeFile(join(dir, "--weird"), "x\n");
    expect((await g.stage(dir, ["--weird"])).ok).toBe(true);
    expect((await git(dir, ["diff", "--cached", "--name-only"])).stdout).toContain("--weird");
  });

  test("discard throws away the edit", async () => {
    await writeFile(join(dir, "a.txt"), "wrecked\n");
    expect((await g.discard(dir, ["a.txt"])).ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });
});

describe("committing", () => {
  test("a multi-line message survives intact", async () => {
    await writeFile(join(dir, "a.txt"), "changed\n");
    await g.stage(dir, ["a.txt"]);
    const msg = "subject line\n\nbody with 'quotes' and \"doubles\" and `ticks`";
    expect((await g.commit(dir, msg)).ok).toBe(true);
    const { stdout } = await git(dir, ["log", "-1", "--format=%B"]);
    expect(stdout).toContain("subject line");
    expect(stdout).toContain("'quotes'");
    expect(stdout).toContain("`ticks`");
  });

  test("committing nothing fails, and says why", async () => {
    const r = await g.commit(dir, "empty");
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("amend rewrites the last commit rather than adding one", async () => {
    const before = (await git(dir, ["rev-list", "--count", "HEAD"])).stdout.trim();
    await writeFile(join(dir, "a.txt"), "amended\n");
    await g.stage(dir, ["a.txt"]);
    expect((await g.commit(dir, "reworded", { amend: true })).ok).toBe(true);
    const after = (await git(dir, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(after).toBe(before);
    expect((await git(dir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("reworded");
  });

  test("a failing pre-commit hook's output is reported, not swallowed", async () => {
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'HOOK SAYS NO'\nexit 1\n", { mode: 0o755 });
    await writeFile(join(dir, "a.txt"), "x\n");
    await g.stage(dir, ["a.txt"]);
    const r = await g.commit(dir, "blocked");
    expect(r.ok).toBe(false);
    expect(r.stderr + r.stdout).toContain("HOOK SAYS NO");
  });

  test("noVerify skips the hook", async () => {
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(dir, "a.txt"), "y\n");
    await g.stage(dir, ["a.txt"]);
    expect((await g.commit(dir, "forced", { noVerify: true })).ok).toBe(true);
  });
});

describe("stash", () => {
  test("push then pop restores the change", async () => {
    await writeFile(join(dir, "a.txt"), "stashed\n");
    expect((await g.stashPush(dir, "wip")).ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    const list = await g.stashList(dir);
    expect(list.length).toBe(1);
    expect(list[0]!.message).toContain("wip");

    expect((await g.stashPop(dir)).ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("stashed\n");
  });

  test("untracked files are only swept up when asked", async () => {
    await writeFile(join(dir, "untracked.txt"), "u\n");
    await g.stashPush(dir, "no-untracked");
    expect(await readFile(join(dir, "untracked.txt"), "utf8")).toBe("u\n");

    await writeFile(join(dir, "a.txt"), "edit\n");
    await g.stashPush(dir, "with-untracked", true);
    await expect(readFile(join(dir, "untracked.txt"), "utf8")).rejects.toThrow();
  });

  test("apply keeps the entry, pop removes it", async () => {
    await writeFile(join(dir, "a.txt"), "s\n");
    await g.stashPush(dir, "keep");
    expect((await g.stashApply(dir)).ok).toBe(true);
    expect((await g.stashList(dir)).length).toBe(1);
    await g.discard(dir, ["a.txt"]);
    await g.stashPop(dir);
    expect((await g.stashList(dir)).length).toBe(0);
  });

  test("drop removes an entry", async () => {
    await writeFile(join(dir, "a.txt"), "d\n");
    await g.stashPush(dir, "doomed");
    expect((await g.stashDrop(dir)).ok).toBe(true);
    expect((await g.stashList(dir)).length).toBe(0);
  });

  test("an empty stash list is empty, not an error", async () => {
    expect(await g.stashList(dir)).toEqual([]);
  });
});

describe("history", () => {
  test("log returns commits newest-first with parent links", async () => {
    await writeFile(join(dir, "a.txt"), "second\n");
    await g.stage(dir, ["a.txt"]);
    await g.commit(dir, "second");

    const log = await g.log(dir, 10);
    expect(log.length).toBe(2);
    expect(log[0]!.subject).toBe("second");
    expect(log[1]!.subject).toBe("first");
    // The newest commit's parent is the older one -- the edge a graph needs.
    expect(log[0]!.parents).toEqual([log[1]!.hash]);
    expect(log[1]!.parents).toEqual([]);
    expect(log[0]!.author).toBe("Tester");
    expect(log[0]!.when).toBeGreaterThan(0);
  });

  test("a subject containing the separator characters still parses", async () => {
    await writeFile(join(dir, "a.txt"), "tricky\n");
    await g.stage(dir, ["a.txt"]);
    await g.commit(dir, "subject with | pipes and \\n literal");
    const log = await g.log(dir, 5);
    expect(log[0]!.subject).toContain("pipes");
  });

  test("a merge commit reports both parents", async () => {
    await git(dir, ["checkout", "-q", "-b", "side"]);
    await writeFile(join(dir, "side.txt"), "s\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "side work"]);
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(join(dir, "main.txt"), "m\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "main work"]);
    await git(dir, ["merge", "--no-ff", "-m", "merge side", "side"]);

    const log = await g.log(dir, 10);
    const merge = log.find((c) => c.subject === "merge side");
    expect(merge).toBeDefined();
    expect(merge!.parents.length).toBe(2);
  });

  test("stash commits stay out of the graph", async () => {
    // `--all` pulls in refs/stash, and each stash contributes up to three
    // commits ("WIP on…", "index on…", "untracked files on…"). On a repo with
    // dozens of stashes that buries the newest real work under bookkeeping.
    await writeFile(join(dir, "a.txt"), "dirty\n");
    await writeFile(join(dir, "untracked.txt"), "new\n");
    await g.stashPush(dir, "wip", true);

    const log = await g.log(dir, 50);
    const subjects = log.map((c) => c.subject);
    expect(subjects.some((s) => /^(WIP|index|untracked files) on/.test(s))).toBe(false);
    // The real history is still there.
    expect(subjects).toContain("first");
  });

  test("a detached HEAD still appears in the graph", async () => {
    // Dropping `--all` for `--branches --remotes --tags` would lose the commit
    // being sat on, which is reachable from no branch at all. Worktrees make
    // this a real state, not a curiosity.
    await git(dir, ["checkout", "-q", "--detach"]);
    await writeFile(join(dir, "a.txt"), "detached\n");
    await git(dir, ["commit", "-qam", "work while detached"]);

    const log = await g.log(dir, 10);
    expect(log.map((c) => c.subject)).toContain("work while detached");
  });

  test("commits are ordered topologically, not by date", async () => {
    /*
     * The readability fix. Git's default order is strict reverse-chronological,
     * so branches worked on the same day interleave commit by commit and every
     * lane in the drawn graph zigzags.
     *
     * Two branches are built with interleaved timestamps: side is committed
     * *between* main's two commits. By date the order would alternate; by
     * topology each branch stays contiguous.
     */
    const commitAt = async (msg: string, when: string, file: string) => {
      await writeFile(join(dir, file), `${msg}\n`);
      await git(dir, ["add", "-A"]);
      await run("git", ["commit", "-qm", msg], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
    };

    await git(dir, ["checkout", "-q", "-b", "side"]);
    await commitAt("side one", "2026-01-01T10:00:00", "s1.txt");
    await commitAt("side two", "2026-01-01T12:00:00", "s2.txt");

    await git(dir, ["checkout", "-q", "main"]);
    // Timestamped between the two side commits, so date order interleaves.
    await commitAt("main one", "2026-01-01T11:00:00", "m1.txt");
    await commitAt("main two", "2026-01-01T13:00:00", "m2.txt");

    const subjects = (await g.log(dir, 20)).map((c) => c.subject);
    const at = (s: string) => subjects.indexOf(s);

    // Each branch's own commits stay adjacent: no third branch's commit lands
    // between them, which is exactly what makes a lane traceable.
    expect(Math.abs(at("side one") - at("side two"))).toBe(1);
    expect(Math.abs(at("main one") - at("main two"))).toBe(1);
  });

  test("branch scope excludes other branches entirely", async () => {
    // The point of the branch view: on a repo where many branches are active,
    // the full graph buries your own work dozens of rows down. This must show
    // your line of history and nobody else's.
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(join(dir, "other.txt"), "theirs\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "someone else's work"]);

    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(join(dir, "mine.txt"), "mine\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "my work"]);

    const subjects = (await g.log(dir, 20, false)).map((c) => c.subject);
    expect(subjects).toContain("my work");
    expect(subjects).toContain("first");        // the trunk it branched from
    expect(subjects).not.toContain("someone else's work");

    // …and the full view still has both, so the toggle is a real choice.
    const allSubjects = (await g.log(dir, 20, true)).map((c) => c.subject);
    expect(allSubjects).toContain("someone else's work");
  });

  test("branch scope follows first parents through a merge", async () => {
    // Without --first-parent a merge drags in every commit the merged branch
    // carried, putting other people's work back into the view whose entire
    // purpose is to exclude it.
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(dir, "f.txt"), "f\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "feature detail one"]);
    await writeFile(join(dir, "f2.txt"), "f2\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "feature detail two"]);

    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["merge", "--no-ff", "-m", "merge feature", "feature"]);

    const subjects = (await g.log(dir, 20, false)).map((c) => c.subject);
    expect(subjects).toContain("merge feature");
    // The merge appears as one row; its branch's internals do not.
    expect(subjects).not.toContain("feature detail one");
    expect(subjects).not.toContain("feature detail two");
  });

  test("branches report which one is checked out", async () => {
    await git(dir, ["branch", "feature"]);
    const bs = await g.branches(dir);
    const names = bs.map((b) => b.name).sort();
    expect(names).toContain("main");
    expect(names).toContain("feature");
    expect(bs.find((b) => b.name === "main")!.current).toBe(true);
    expect(bs.find((b) => b.name === "feature")!.current).toBe(false);
  });

  test("blame attributes each line to the commit that last touched it", async () => {
    await writeFile(join(dir, "a.txt"), "one\nEDITED\nthree\n");
    await g.stage(dir, ["a.txt"]);
    await g.commit(dir, "edit line two");

    const blame = await g.blame(dir, "a.txt");
    expect(blame.length).toBe(3);
    expect(blame[1]!.summary).toBe("edit line two");
    // Lines 1 and 3 still belong to the original commit.
    expect(blame[0]!.summary).toBe("first");
    expect(blame[2]!.summary).toBe("first");
    // Author and time are carried even for lines whose header git omits.
    expect(blame[0]!.author).toBe("Tester");
    expect(blame[2]!.when).toBeGreaterThan(0);
  });

  test("blame on a missing file is empty, not a throw", async () => {
    expect(await g.blame(dir, "nope.txt")).toEqual([]);
  });
});

describe("remotes", () => {
  test("a push with no remote fails with git's own message, and never hangs", async () => {
    const r = await g.push(dir);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("push to a real local remote succeeds", async () => {
    const remote = await mkdtemp(join(tmpdir(), "fove-remote-"));
    try {
      await git(remote, ["init", "-q", "--bare"]);
      await git(dir, ["remote", "add", "origin", remote]);
      const r = await g.push(dir, { remote: "origin", branch: "main", setUpstream: true });
      expect(r.ok).toBe(true);
      expect((await git(remote, ["rev-list", "--count", "main"])).stdout.trim()).toBe("1");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});
