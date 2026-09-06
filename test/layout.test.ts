import { describe, expect, test, beforeEach } from "vitest";
import {
  leaf, split, closePane, resize, movePane, place, paneIds, isValid,
  clampRatio, MIN_RATIO, __resetIds, dropEdge, edgeToSplit, dropPreview, swapPanes, type Node,
} from "../src/shared/layout.js";

beforeEach(() => __resetIds());
const R = { x: 0, y: 0, w: 1000, h: 600 };

describe("split", () => {
  test("one pane becomes two side by side", () => {
    const t = split(leaf("p1"), "p1", "p2", "row");
    expect(paneIds(t)).toEqual(["p1", "p2"]);
    expect(t.kind).toBe("branch");
    expect(isValid(t)).toBe(true);
  });
  test("`before` puts the new pane on the leading side", () => {
    expect(paneIds(split(leaf("p1"), "p1", "p2", "row", true))).toEqual(["p2", "p1"]);
  });
  test("splitting an unknown pane is a no-op", () => {
    const t = leaf("p1");
    expect(split(t, "nope", "p2", "row")).toBe(t);
  });
  test("nested splits stay valid and keep every pane", () => {
    let t: Node = leaf("p1");
    t = split(t, "p1", "p2", "row");
    t = split(t, "p2", "p3", "column");
    t = split(t, "p3", "p4", "row");
    expect(paneIds(t).sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(isValid(t)).toBe(true);
  });
});

describe("closePane", () => {
  test("the sibling takes the parent's place", () => {
    const t = split(leaf("p1"), "p1", "p2", "row");
    const after = closePane(t, "p2")!;
    expect(after.kind).toBe("leaf");
    expect(paneIds(after)).toEqual(["p1"]);
  });
  test("closing the last pane yields null", () => {
    expect(closePane(leaf("p1"), "p1")).toBeNull();
  });
  test("closing deep in the tree leaves no empty branches", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    const after = closePane(t, "c")!;
    expect(paneIds(after)).toEqual(["a", "b"]);
    expect(isValid(after)).toBe(true);
  });
  test("closing an unknown pane is a no-op", () => {
    const t = split(leaf("p1"), "p1", "p2", "row");
    expect(closePane(t, "ghost")).toBe(t);
  });
  test("closing every pane in turn ends at null without throwing", () => {
    let t: Node | null = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t!, "b", "c", "column");
    for (const id of ["b", "a", "c"]) t = closePane(t!, id);
    expect(t).toBeNull();
  });
});

describe("resize", () => {
  test("sets the ratio of the addressed branch only", () => {
    const t = split(leaf("p1"), "p1", "p2", "row") as any;
    const after = resize(t, t.id, 0.75) as any;
    expect(after.ratio).toBe(0.75);
  });
  test("clamps so a pane can never be crushed to nothing", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(1 - MIN_RATIO);
    expect(clampRatio(-5)).toBe(MIN_RATIO);
    const t = split(leaf("p1"), "p1", "p2", "row") as any;
    expect((resize(t, t.id, 0.001) as any).ratio).toBe(MIN_RATIO);
    expect(isValid(resize(t, t.id, 99))).toBe(true);
  });
});

describe("movePane (drag to reparent)", () => {
  test("moves a pane beside another", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    const after = movePane(t, "a", "c", "row");
    expect(paneIds(after).sort()).toEqual(["a", "b", "c"]);
    expect(isValid(after)).toBe(true);
  });
  test("moving onto itself is a no-op", () => {
    const t = split(leaf("a"), "a", "b", "row");
    expect(movePane(t, "a", "a", "row")).toBe(t);
  });
  test("moving a pane onto its only sibling does not lose either", () => {
    const t = split(leaf("a"), "a", "b", "row");
    const after = movePane(t, "a", "b", "column");
    expect(paneIds(after).sort()).toEqual(["a", "b"]);
    expect(isValid(after)).toBe(true);
  });
  test("never duplicates a pane", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    t = split(t, "c", "d", "row");
    for (const [from, to] of [["a","d"],["d","b"],["b","c"],["c","a"]] as const) {
      t = movePane(t, from, to, "row");
      const ids = paneIds(t);
      expect(new Set(ids).size).toBe(ids.length);
      expect(isValid(t)).toBe(true);
    }
  });
});

describe("place (geometry)", () => {
  test("a single pane fills the rect", () => {
    const { panes, dividers } = place(leaf("p1"), R);
    expect(panes[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 600, paneId: "p1" });
    expect(dividers).toHaveLength(0);
  });
  test("a row split halves the width, minus the gap", () => {
    const t = split(leaf("p1"), "p1", "p2", "row");
    const { panes, dividers } = place(t, R, 4);
    expect(panes[0]!.w).toBe(498);
    expect(panes[1]!.w).toBe(498);
    expect(panes[1]!.x).toBe(502);
    expect(dividers[0]).toMatchObject({ x: 498, w: 4, h: 600 });
  });
  test("a column split halves the height", () => {
    const t = split(leaf("p1"), "p1", "p2", "column");
    const { panes } = place(t, R, 4);
    expect(panes[0]!.h).toBe(298);
    expect(panes[1]!.y).toBe(302);
  });
  test("panes never overlap, at any depth", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    t = split(t, "a", "d", "column");
    const { panes } = place(t, R, 4);
    for (let i = 0; i < panes.length; i++)
      for (let j = i + 1; j < panes.length; j++) {
        const p = panes[i]!, q = panes[j]!;
        const disjoint =
          p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
        expect(disjoint).toBe(true);
      }
  });
  test("every pane stays inside the container and has positive area", () => {
    let t: Node = leaf("a");
    for (const [from, to, d] of [["a","b","row"],["b","c","column"],["c","d","row"]] as const)
      t = split(t, from, to, d);
    for (const p of place(t, R, 4).panes) {
      expect(p.w).toBeGreaterThan(0);
      expect(p.h).toBeGreaterThan(0);
      expect(p.x + p.w).toBeLessThanOrEqual(R.w + 0.001);
      expect(p.y + p.h).toBeLessThanOrEqual(R.h + 0.001);
    }
  });
  test("one divider per branch", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    expect(place(t, R).dividers).toHaveLength(2);
  });
  test("a tiny container does not produce negative sizes", () => {
    const t = split(leaf("a"), "a", "b", "row");
    for (const p of place(t, { x: 0, y: 0, w: 2, h: 2 }, 4).panes) {
      expect(p.w).toBeGreaterThanOrEqual(0);
      expect(p.h).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("isValid", () => {
  test("rejects a tree containing the same pane twice", () => {
    const bad: Node = { kind: "branch", id: "b", dir: "row", ratio: 0.5, a: leaf("x"), b: leaf("x") };
    expect(isValid(bad)).toBe(false);
  });
  test("rejects an out-of-range ratio (guards restore-from-disk)", () => {
    const bad: Node = { kind: "branch", id: "b", dir: "row", ratio: 0.001, a: leaf("x"), b: leaf("y") };
    expect(isValid(bad)).toBe(false);
  });
});

describe("serialization", () => {
  test("survives a JSON round trip", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    const back = JSON.parse(JSON.stringify(t)) as Node;
    expect(back).toEqual(t);
    expect(isValid(back)).toBe(true);
    expect(place(back, R)).toEqual(place(t, R));
  });
});

describe("drop zones", () => {
  const R2 = { x: 0, y: 0, w: 100, h: 100 };

  test("edges are detected near each side", () => {
    expect(dropEdge(R2, 5, 50)).toBe("left");
    expect(dropEdge(R2, 95, 50)).toBe("right");
    expect(dropEdge(R2, 50, 5)).toBe("top");
    expect(dropEdge(R2, 50, 95)).toBe("bottom");
  });
  test("the middle is center, not an edge", () => {
    expect(dropEdge(R2, 50, 50)).toBe("center");
    expect(dropEdge(R2, 40, 60)).toBe("center");
  });
  test("the nearest edge wins in a corner", () => {
    // Slightly nearer the left than the top.
    expect(dropEdge(R2, 4, 8)).toBe("left");
    expect(dropEdge(R2, 8, 4)).toBe("top");
  });
  test("works on non-square panes", () => {
    const wide = { x: 0, y: 0, w: 400, h: 50 };
    expect(dropEdge(wide, 5, 25)).toBe("left");
    expect(dropEdge(wide, 200, 3)).toBe("top");
    expect(dropEdge(wide, 200, 25)).toBe("center");
  });
  test("offset rects are handled in absolute coordinates", () => {
    const off = { x: 500, y: 300, w: 100, h: 100 };
    expect(dropEdge(off, 505, 350)).toBe("left");
    expect(dropEdge(off, 550, 350)).toBe("center");
  });
  test("out-of-bounds and degenerate rects fall back to center", () => {
    expect(dropEdge(R2, -10, 50)).toBe("center");
    expect(dropEdge({ x: 0, y: 0, w: 0, h: 0 }, 0, 0)).toBe("center");
  });

  test("edges map to split arguments; center does not split", () => {
    expect(edgeToSplit("left")).toEqual({ dir: "row", before: true });
    expect(edgeToSplit("right")).toEqual({ dir: "row", before: false });
    expect(edgeToSplit("top")).toEqual({ dir: "column", before: true });
    expect(edgeToSplit("bottom")).toEqual({ dir: "column", before: false });
    expect(edgeToSplit("center")).toBeNull();
  });

  test("preview covers the half a drop would occupy", () => {
    expect(dropPreview(R2, "right")).toEqual({ x: 50, y: 0, w: 50, h: 100 });
    expect(dropPreview(R2, "bottom")).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(dropPreview(R2, "center")).toEqual(R2);
  });
});

describe("swapPanes", () => {
  test("exchanges two panes without changing the tree shape", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    const before = JSON.stringify(t, (k, v) => (k === "paneId" ? "?" : v));
    const after = swapPanes(t, "a", "c");
    expect(JSON.stringify(after, (k, v) => (k === "paneId" ? "?" : v))).toBe(before);
    expect(paneIds(after)).toEqual(["c", "b", "a"].slice(0, paneIds(after).length));
    expect(isValid(after)).toBe(true);
  });
  test("swapping a pane with itself is a no-op", () => {
    const t = split(leaf("a"), "a", "b", "row");
    expect(swapPanes(t, "a", "a")).toBe(t);
  });
  test("never loses or duplicates a pane", () => {
    let t: Node = leaf("a");
    t = split(t, "a", "b", "row");
    t = split(t, "b", "c", "column");
    const after = swapPanes(t, "a", "b");
    expect(paneIds(after).sort()).toEqual(["a", "b", "c"]);
    expect(isValid(after)).toBe(true);
  });
});
