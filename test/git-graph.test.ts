import { describe, expect, test } from "vitest";
import { layout, graphWidth, type GraphCommit } from "../src/shared/git-graph.js";

/** Newest-first, as `git log` returns. */
const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

describe("commit graph layout", () => {
  test("a linear history is a single lane", () => {
    const rows = layout([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(graphWidth(rows)).toBe(1);
  });

  test("the root commit ends its lane", () => {
    const rows = layout([c("a")]);
    expect(rows[0]!.lane).toBe(0);
    // Nothing continues past a commit with no parents.
    expect(rows[0]!.edges.every((e) => e.ends || e.target !== "")).toBe(true);
  });

  test("a merge brings a second lane back in", () => {
    //   m
    //   |\
    //   x y
    //   |/
    //   b
    const rows = layout([c("m", "x", "y"), c("x", "b"), c("y", "b"), c("b")]);
    const m = rows[0]!;
    expect(m.parents ?? m.commit.parents).toHaveLength(2);
    // The merge opens a lane for its second parent.
    expect(m.edges.some((e) => e.target === "y" && e.from !== e.to)).toBe(true);
    // Both sides converge again on b.
    expect(graphWidth(rows)).toBeGreaterThanOrEqual(2);
    expect(rows[3]!.commit.hash).toBe("b");
  });

  test("two independent heads occupy separate lanes", () => {
    const rows = layout([c("h1", "a"), c("h2", "a"), c("a")]);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(1);
    // They rejoin at their shared parent, in the leftmost waiting lane.
    expect(rows[2]!.lane).toBe(0);
  });

  test("a lane is reused once it is free", () => {
    // A short side branch, then unrelated linear history.
    const rows = layout([
      c("m", "a", "s"), c("a", "b"), c("s", "b"), c("b", "z"), c("z"),
    ]);
    // After the branches converge on b, the graph narrows again.
    expect(rows[4]!.width).toBe(0);
  });

  test("every edge references a lane that exists on its row", () => {
    const rows = layout([
      c("m", "x", "y"), c("x", "b"), c("y", "b"), c("b", "r"), c("r"),
    ]);
    for (const r of rows) {
      for (const e of r.edges) {
        expect(e.from).toBeGreaterThanOrEqual(0);
        expect(e.to).toBeGreaterThanOrEqual(0);
        expect(Math.max(e.from, e.to)).toBeLessThanOrEqual(r.width);
      }
    }
  });

  test("a truncated log does not hang or invent commits", () => {
    // `b` is referenced as a parent but never appears -- git log --max-count.
    const rows = layout([c("c", "b")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lane).toBe(0);
  });

  test("an octopus merge opens a lane per extra parent", () => {
    const rows = layout([c("o", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
    expect(graphWidth(rows)).toBeGreaterThanOrEqual(3);
    const o = rows[0]!;
    for (const p of ["p1", "p2", "p3"]) {
      expect(o.edges.some((e) => e.target === p)).toBe(true);
    }
  });

  test("an empty log produces no rows", () => {
    expect(layout([])).toEqual([]);
    expect(graphWidth([])).toBe(1);
  });

  test("every commit appears exactly once, in input order", () => {
    const input = [c("d", "c"), c("c", "b"), c("b", "a"), c("a")];
    const rows = layout(input);
    expect(rows.map((r) => r.commit.hash)).toEqual(["d", "c", "b", "a"]);
  });
});
