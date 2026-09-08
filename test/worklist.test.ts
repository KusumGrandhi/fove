/**
 * The tree as a worklist.
 *
 * The ordering is the feature. A tree sorted by name is something every editor
 * already has — including fove's own editor pane — so what makes this worth a
 * column is that the top of it is the work. That claim is worth pinning.
 */

import { describe, expect, it } from "vitest";
import {
  byAttention, buildRows, attentionCount, RECENT_MS,
  type WorklistFile,
} from "../src/shared/worklist.js";

const f = (path: string, tone: WorklistFile["tone"], touchedAt?: number): WorklistFile =>
  ({ path, tone, touchedAt });

const NOW = 1_700_000_000_000;

describe("byAttention", () => {
  it("ranks failing above everything", () => {
    const out = byAttention([
      f("z.py", "normal"), f("a.py", "failing"), f("m.py", "changed"),
    ], NOW);
    expect(out[0]!.path).toBe("a.py");
  });

  it("uses the handoff's order: failing, drifted, active, changed, normal, quiet", () => {
    const out = byAttention([
      f("e.py", "normal"), f("f.py", "quiet"), f("d.py", "changed"),
      f("c.py", "active"), f("b.py", "drifted"), f("a.py", "failing"),
    ], NOW);
    expect(out.map((x) => x.path)).toEqual(
      ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"],
    );
  });

  it("breaks a tie by recency, newest first", () => {
    const out = byAttention([
      f("old.py", "changed", NOW - 10 * 60_000),
      f("new.py", "changed", NOW - 60_000),
    ], NOW);
    expect(out[0]!.path).toBe("new.py");
  });

  it("ignores recency beyond the hour window", () => {
    /*
     * "Changed three days ago" and "changed five days ago" are the same thing.
     * Sorting by them would reshuffle the list on every render for no
     * information, so beyond the window the tie falls to path.
     */
    const out = byAttention([
      f("b.py", "normal", NOW - 3 * 24 * 3600_000),
      f("a.py", "normal", NOW - 5 * 24 * 3600_000),
    ], NOW);
    expect(out.map((x) => x.path)).toEqual(["a.py", "b.py"]);
  });

  it("prefers a recent file over one outside the window at the same rank", () => {
    const out = byAttention([
      f("stale.py", "changed", NOW - 2 * RECENT_MS),
      f("fresh.py", "changed", NOW - 1000),
    ], NOW);
    expect(out[0]!.path).toBe("fresh.py");
  });

  it("is stable: two files with no timestamp fall to path order", () => {
    const out = byAttention([f("b.py", "normal"), f("a.py", "normal")], NOW);
    expect(out.map((x) => x.path)).toEqual(["a.py", "b.py"]);
  });

  it("does not mutate its input", () => {
    const input = [f("z.py", "normal"), f("a.py", "failing")];
    byAttention(input, NOW);
    expect(input[0]!.path).toBe("z.py");
  });
});

describe("buildRows", () => {
  it("is flat in attention mode, with full paths", () => {
    /*
     * Grouping by directory would reimpose the hierarchy the ranking exists to
     * escape — and two files called `helpers.py` are indistinguishable without
     * their paths, which on a large repo is common.
     */
    const rows = buildRows([
      f("api/payments/helpers.py", "failing"),
      f("core/risk/helpers.py", "normal"),
    ], "attention", NOW);

    expect(rows.every((r) => r.kind === "file")).toBe(true);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows[0]!.name).toBe("api/payments/helpers.py");
  });

  it("sorts by path in alpha mode regardless of tone", () => {
    const rows = buildRows([f("z.py", "failing"), f("a.py", "quiet")], "alpha", NOW);
    expect(rows.map((r) => r.path)).toEqual(["a.py", "z.py"]);
  });

  it("restores directories in hierarchy mode", () => {
    const rows = buildRows([
      f("api/verify.py", "normal"),
      f("api/charge.py", "changed"),
    ], "hierarchy", NOW);

    const dirs = rows.filter((r) => r.kind === "dir");
    expect(dirs.map((d) => d.name)).toEqual(["api"]);
    // Files render as their leaf name, indented under the directory.
    const files = rows.filter((r) => r.kind === "file");
    expect(files.map((r) => r.name).sort()).toEqual(["charge.py", "verify.py"]);
    expect(files.every((r) => r.depth === 1)).toBe(true);
  });

  it("folds a wholly quiet subtree into one row", () => {
    // Forty rows of untouched code between you and the work is the thing the
    // worklist exists to prevent.
    const rows = buildRows([
      f("sdk/a.py", "quiet"), f("sdk/b.py", "quiet"),
      f("sdk/c.py", "quiet"), f("sdk/d.py", "quiet"),
    ], "hierarchy", NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "dir", folded: 4, tone: "quiet" });
    expect(rows[0]!.badge).toContain("4");
  });

  it("does not fold a subtree containing anything live", () => {
    const rows = buildRows([
      f("sdk/a.py", "quiet"), f("sdk/b.py", "quiet"),
      f("sdk/c.py", "quiet"), f("sdk/hot.py", "failing"),
    ], "hierarchy", NOW);
    expect(rows.filter((r) => r.kind === "file")).toHaveLength(4);
  });

  it("does not fold a directory of one or two quiet files", () => {
    // Folding two rows into one row plus a count saves nothing and hides them.
    const rows = buildRows([f("x/a.py", "quiet"), f("x/b.py", "quiet")], "hierarchy", NOW);
    expect(rows.filter((r) => r.kind === "file")).toHaveLength(2);
  });

  it("emits each directory once across groups", () => {
    const rows = buildRows([
      f("api/v1/a.py", "normal"),
      f("api/v2/b.py", "normal"),
    ], "hierarchy", NOW);
    const apiRows = rows.filter((r) => r.kind === "dir" && r.path === "api");
    expect(apiRows).toHaveLength(1);
  });

  it("handles a file at the repository root", () => {
    const rows = buildRows([f("README.md", "normal")], "hierarchy", NOW);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "file", name: "README.md", depth: 0 }),
    ]);
  });

  it("returns nothing for no files", () => {
    expect(buildRows([], "attention", NOW)).toEqual([]);
  });
});

describe("attentionCount", () => {
  it("counts only what is worth looking at", () => {
    const files = [
      f("a.py", "failing"), f("b.py", "drifted"), f("c.py", "active"),
      f("d.py", "changed"), f("e.py", "normal"), f("f.py", "quiet"),
    ];
    // Everything through "changed"; normal and quiet are not work.
    expect(attentionCount(files)).toBe(4);
  });

  it("is zero for a quiet repository", () => {
    expect(attentionCount([f("a.py", "normal"), f("b.py", "quiet")])).toBe(0);
  });
});
