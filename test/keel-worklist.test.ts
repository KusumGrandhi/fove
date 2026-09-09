/**
 * What the worklist column actually contains.
 *
 * This exists because of a bug that shipped in v0.9.0 and was caught by
 * looking at the running app: on `core` -- a clean, busy, shared repository --
 * the column showed 60 files, none of which had changed. Every row had been
 * borrowed from "the last 15 commits by anyone", which on a repository with a
 * dozen active people is nine other people's merges presented as your worklist.
 *
 * The column answers *what is this turn's work*. The rules that keep it honest:
 *
 *   - uncommitted files are the work, and they win
 *   - history is a fallback for a clean tree, never a supplement
 *   - the fallback is one commit, because that is the most that can honestly
 *     be called the thing you were just doing
 *   - the counts distinguish real changes from borrowed rows, so the UI can
 *     say which it is showing rather than implying the flattering one
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeelService } from "../src/main/keel.js";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

/** A disposable repository. Never a real one -- see the project's rules. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fove-worklist-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, body = "x\n") => {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
};

const commit = (msg: string) => { git("add", "-A"); git("commit", "-qm", msg); };

/** A service with no session dependency; the worklist does not use one. */
const service = () => new KeelService({} as never);

describe("a clean tree", () => {
  it("falls back to the last commit, and says the rows are history", async () => {
    write("a.ts"); write("b.ts");
    commit("first");

    const k = service();
    await k.begin(dir);
    const w = await k.worklist(dir);

    expect(w.changedCount).toBe(0);
    expect(w.fromHistory).toBe(2);
    expect(w.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    // The badge is what the UI shows on the row: it must not read as "yours now".
    expect(w.files.every((f) => f.badge === "last commit")).toBe(true);
  });

  it("borrows from ONE commit, not from history at large", async () => {
    /*
     * The actual v0.9.0 bug. Fifteen commits of other people's work is a
     * changelog, not a worklist -- measured at 60 rows and 0 changes on `core`.
     */
    write("old-1.ts"); write("old-2.ts"); write("old-3.ts");
    commit("older work");
    write("newest.ts");
    commit("the commit you just made");

    const w = await (async () => { const k = service(); await k.begin(dir); return k.worklist(dir); })();

    expect(w.files.map((f) => f.path)).toEqual(["newest.ts"]);
    expect(w.fromHistory).toBe(1);
  });
});

describe("a dirty tree", () => {
  it("shows the uncommitted files and borrows nothing", async () => {
    write("committed.ts");
    commit("first");
    write("uncommitted.ts");

    const k = service();
    await k.begin(dir);
    const w = await k.worklist(dir);

    // History is a fallback, never a supplement: a file you are working on
    // must not be buried under files you already finished.
    expect(w.fromHistory).toBe(0);
    expect(w.files.map((f) => f.path)).toContain("uncommitted.ts");
    expect(w.files.map((f) => f.path)).not.toContain("committed.ts");
  });

  it("counts only what moved inside the turn window as changed", async () => {
    /*
     * A file already dirty when the turn began is dirty, not this turn's work.
     * `begin` is the boundary, so anything written before it stays `normal`.
     */
    write("already-dirty.ts");

    const k = service();
    await k.begin(dir);          // the turn starts here
    write("during-turn.ts");

    const w = await k.worklist(dir);
    const byPath = new Map(w.files.map((f) => [f.path, f]));

    expect(byPath.get("during-turn.ts")?.tone).toBe("changed");
    expect(byPath.get("already-dirty.ts")?.tone).toBe("normal");
    expect(w.changedCount).toBe(1);
  });
});

describe("an empty repository", () => {
  it("reports nothing rather than inventing rows", async () => {
    const k = service();
    await k.begin(dir);
    const w = await k.worklist(dir);

    expect(w.files).toEqual([]);
    expect(w.changedCount).toBe(0);
    expect(w.fromHistory).toBe(0);
  });
});
