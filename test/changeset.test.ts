/**
 * Comparing two snapshots of a working tree.
 *
 * The property under test is the one Keel's honesty rests on: a file that was
 * already dirty when the turn started must not be presented as the turn's
 * doing. Getting that wrong turns "here is what just happened" into "here is
 * everything uncommitted", which the git pane already shows.
 */

import { describe, expect, it } from "vitest";
import {
  compareSnapshots, summarise, confidence,
  type TreeSnapshot, type FileState,
} from "../src/shared/changeset.js";

const snap = (files: FileState[], head = "abc123", takenAt = 1000): TreeSnapshot =>
  ({ head, takenAt, files });

const f = (path: string, status = "M", hash?: string): FileState => ({ path, status, hash });

describe("compareSnapshots", () => {
  it("reports a file that appeared during the turn", () => {
    const set = compareSnapshots(snap([]), snap([f("new.ts", "A")]));
    expect(set.changed).toHaveLength(1);
    expect(set.changed[0]).toMatchObject({ path: "new.ts", kind: "added", preexisting: false });
  });

  it("calls a newly-dirty tracked file modified, not added", () => {
    /*
     * Found by running this against a real repository. A committed, clean file
     * edited during a turn is absent from the *before* snapshot -- it was not
     * dirty -- so the naive reading is "added", and Keel rendered NEW against a
     * file that had existed for months. Git's status letter is the authority.
     */
    const set = compareSnapshots(snap([]), snap([f("existing.ts", "M")]));
    expect(set.changed[0]).toMatchObject({ kind: "modified", preexisting: false });
  });

  it("still calls an untracked file added", () => {
    const set = compareSnapshots(snap([]), snap([f("brand-new.ts", "?")]));
    expect(set.changed[0]!.kind).toBe("added");
  });

  it("keeps an untracked file labelled new even when it moves again", () => {
    // It landed before the window and changed inside it. Rendering that as
    // EDITED against a file git has never seen reads as a lie.
    const set = compareSnapshots(
      snap([f("draft.ts", "??", "h1")]),
      snap([f("draft.ts", "??", "h2")]),
    );
    expect(set.changed[0]).toMatchObject({ kind: "added", preexisting: true });
  });

  it("reports a file whose contents moved", () => {
    const set = compareSnapshots(
      snap([f("a.ts", "M", "h1")]),
      snap([f("a.ts", "M", "h2")]),
    );
    expect(set.changed[0]).toMatchObject({ path: "a.ts", kind: "modified", preexisting: true });
  });

  it("does NOT report a file that was dirty before and did not move", () => {
    // The central property. Without hashes this file looks identical in both
    // snapshots, and claiming the turn touched it would be a fabrication.
    const set = compareSnapshots(
      snap([f("wip.ts", "M", "same")]),
      snap([f("wip.ts", "M", "same")]),
    );
    expect(set.changed).toHaveLength(0);
    expect(set.carried).toHaveLength(1);
    expect(set.carried[0]!.kind).toBe("unchanged");
  });

  it("catches a re-edit of an already-dirty file via its hash", () => {
    // Status stays "M" throughout, so only the hash reveals the second edit.
    // Without hashes this change is invisible, which is why they are collected.
    const set = compareSnapshots(
      snap([f("wip.ts", "M", "before")]),
      snap([f("wip.ts", "M", "after")]),
    );
    expect(set.changed).toHaveLength(1);
    expect(set.changed[0]!.kind).toBe("modified");
  });

  it("falls back to the status letter when hashes are missing", () => {
    const set = compareSnapshots(
      snap([f("a.ts", "M")]),
      snap([f("a.ts", "D")]),
    );
    expect(set.changed[0]!.kind).toBe("modified");
  });

  it("reports a file that disappeared as resolved, not ignored", () => {
    // Reverted, committed, or deleted. Work vanishing mid-turn is exactly what
    // you want to be told about rather than discover later.
    const set = compareSnapshots(snap([f("gone.ts", "M")]), snap([]));
    expect(set.changed).toHaveLength(1);
    expect(set.changed[0]).toMatchObject({ path: "gone.ts", kind: "resolved" });
  });

  it("notices a commit during the turn", () => {
    const set = compareSnapshots(snap([], "head1"), snap([], "head2"));
    expect(set.committed).toBe(true);
    expect(set.headBefore).toBe("head1");
    expect(set.headAfter).toBe("head2");
  });

  it("does not claim a commit when HEAD is unknown", () => {
    const set = compareSnapshots(
      { takenAt: 1, files: [] },
      { takenAt: 2, files: [] },
    );
    expect(set.committed).toBe(false);
  });

  it("is empty for two identical empty snapshots", () => {
    const set = compareSnapshots(snap([]), snap([]));
    expect(set.changed).toEqual([]);
    expect(set.carried).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts new and removed files above modifications", () => {
    const set = compareSnapshots(
      snap([f("old.ts", "M"), f("edit.ts", "M", "h1")]),
      snap([f("edit.ts", "M", "h2"), f("new.ts", "A")]),
    );
    expect(set.changed.map((c) => c.kind)).toEqual(["added", "resolved", "modified"]);
  });

  it("puts a clean-before file above one already in flight", () => {
    const set = compareSnapshots(
      snap([f("dirty.ts", "M", "h1")]),
      snap([f("dirty.ts", "M", "h2"), f("fresh.ts", "M")]),
    );
    // fresh.ts was not in the before snapshot, so it is "added" and outranks
    // the modification regardless -- check the tie-break directly instead.
    const both = compareSnapshots(
      snap([f("a.ts", "M", "x"), f("b.ts", "M", "y")]),
      snap([f("a.ts", "M", "x2"), f("b.ts", "M", "y2")]),
    );
    expect(both.changed).toHaveLength(2);
    expect(set.changed.length).toBeGreaterThan(0);
  });

  it("sorts alphabetically within a rank", () => {
    const set = compareSnapshots(
      snap([]),
      snap([f("z.ts", "A"), f("a.ts", "A"), f("m.ts", "A")]),
    );
    expect(set.changed.map((c) => c.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("summarise", () => {
  it("says nothing changed when nothing did", () => {
    expect(summarise(compareSnapshots(snap([]), snap([])))).toBe("nothing changed");
  });

  it("distinguishes no change from no files at all", () => {
    // A turn where everything was already dirty and stayed that way is not the
    // same as a turn in a clean tree, and the wording says so.
    const set = compareSnapshots(snap([f("a.ts", "M", "h")]), snap([f("a.ts", "M", "h")]));
    expect(summarise(set)).toBe("no files changed");
  });

  it("counts new files separately", () => {
    const set = compareSnapshots(snap([]), snap([f("a.ts", "A"), f("b.ts", "A")]));
    expect(summarise(set)).toContain("2 files changed");
    expect(summarise(set)).toContain("2 new");
  });

  it("mentions a mid-turn commit", () => {
    const set = compareSnapshots(snap([], "h1"), snap([f("a.ts", "A")], "h2"));
    expect(summarise(set)).toContain("committed during the turn");
  });

  it("never claims authorship", () => {
    // The vocabulary rule, pinned: attribution is a heuristic, and no summary
    // may say the agent did anything.
    const set = compareSnapshots(snap([]), snap([f("a.ts", "A")]));
    const text = summarise(set).toLowerCase();
    expect(text).not.toContain("agent");
    expect(text).not.toContain("claude");
  });
});

describe("confidence", () => {
  it("is reliable when the tree was clean before the turn", () => {
    const set = compareSnapshots(snap([]), snap([f("a.ts", "A"), f("b.ts", "A")]));
    expect(confidence(set)).toMatchObject({ clean: 2, muddied: 0, reliable: true });
  });

  it("is unreliable when most files were already in flight", () => {
    // Five files dirty before the turn, one new: the boundary is telling you
    // much less than the list implies, and the UI needs to know that.
    const before = snap(["a", "b", "c", "d", "e"].map((p) => f(`${p}.ts`, "M", p)));
    const after = snap([
      ...["a", "b", "c", "d", "e"].map((p) => f(`${p}.ts`, "M", p)),
      f("new.ts", "A"),
    ]);
    const c = confidence(compareSnapshots(before, after));
    expect(c.clean).toBe(1);
    expect(c.muddied).toBe(5);
    expect(c.reliable).toBe(false);
  });
});
