import { describe, expect, test } from "vitest";
import { order, insert, setPinned, moveTab, close, firstLooseIndex } from "../src/shared/tabs.js";

type T = { id: string; pinned?: boolean };
const ids = (t: T[]) => t.map((x) => x.id).join(",");
const make = (spec: string): T[] =>
  spec.split(",").map((s) => (s.startsWith("*") ? { id: s.slice(1), pinned: true } : { id: s }));

describe("order", () => {
  test("pinned tabs come first, each group keeping its order", () => {
    expect(ids(order(make("a,*b,c,*d")))).toBe("b,d,a,c");
  });
  test("all-loose and all-pinned are unchanged", () => {
    expect(ids(order(make("a,b,c")))).toBe("a,b,c");
    expect(ids(order(make("*a,*b")))).toBe("a,b");
  });
  test("empty is safe", () => {
    expect(order([])).toEqual([]);
  });
});

describe("insert", () => {
  test("a new tab lands after the pinned block, not at the end", () => {
    expect(ids(insert(make("*a,*b,c"), { id: "new" }))).toBe("a,b,new,c");
  });
  test("with no pinned tabs it goes first", () => {
    expect(ids(insert(make("a,b"), { id: "new" }))).toBe("new,a,b");
  });
  test("with everything pinned it goes last", () => {
    expect(ids(insert(make("*a,*b"), { id: "new" }))).toBe("a,b,new");
  });
});

describe("setPinned", () => {
  test("pinning moves the tab to the end of the pinned block", () => {
    expect(ids(setPinned(make("*a,b,c"), "c", true))).toBe("a,c,b");
  });
  test("unpinning drops it to the front of the loose block", () => {
    expect(ids(setPinned(make("*a,*b,c"), "a", false))).toBe("b,a,c");
  });
  test("pinning is idempotent", () => {
    const t = make("*a,b");
    expect(setPinned(t, "a", true)).toBe(t);
    expect(setPinned(t, "b", false)).toBe(t);
  });
  test("an unknown id is a no-op", () => {
    const t = make("a,b");
    expect(setPinned(t, "ghost", true)).toBe(t);
  });
  test("never loses or duplicates a tab", () => {
    let t = make("a,b,c,d");
    for (const [id, p] of [["b", true], ["d", true], ["b", false], ["a", true]] as const) {
      t = setPinned(t, id, p);
      expect(t).toHaveLength(4);
      expect(new Set(t.map((x) => x.id)).size).toBe(4);
    }
  });
});

describe("moveTab", () => {
  test("a loose tab cannot move into the pinned block", () => {
    // "c" is loose; index 0 is inside the pinned block, so it clamps to 2.
    expect(ids(moveTab(make("*a,*b,c,d"), "c", 0))).toBe("a,b,c,d");
  });
  test("a pinned tab reorders within the pinned block", () => {
    expect(ids(moveTab(make("*a,*b,c"), "b", 0))).toBe("b,a,c");
  });
  test("a pinned tab cannot leave the pinned block", () => {
    expect(ids(moveTab(make("*a,*b,c,d"), "a", 3))).toBe("b,a,c,d");
  });
  test("loose tabs reorder among themselves", () => {
    expect(ids(moveTab(make("*a,b,c,d"), "d", 1))).toBe("a,d,b,c");
  });
  test("out-of-range indices clamp rather than throw", () => {
    expect(ids(moveTab(make("a,b,c"), "a", 99))).toBe("b,c,a");
    expect(ids(moveTab(make("a,b,c"), "c", -5))).toBe("c,a,b");
  });
  test("an unknown id is a no-op", () => {
    const t = make("a,b");
    expect(moveTab(t, "ghost", 0)).toBe(t);
  });
});

describe("close", () => {
  test("survivors keep their order and their pins", () => {
    const after = close(make("*a,b,*c,d"), "b");
    expect(ids(after)).toBe("a,c,d");
    expect(after.filter((t) => t.pinned).map((t) => t.id)).toEqual(["a", "c"]);
  });
  test("closing a pinned tab does not disturb the rest", () => {
    expect(ids(close(make("*a,*b,c"), "a"))).toBe("b,c");
  });
});

describe("pinned tabs hold their exact spot", () => {
  test("through a churn of opens and closes", () => {
    let t = make("*keep,a");
    t = insert(t, { id: "b" });
    t = insert(t, { id: "c" });
    t = close(t, "a");
    t = close(t, "b");
    t = insert(t, { id: "d" });
    // "keep" never moved off index 0.
    expect(t[0]!.id).toBe("keep");
    expect(t[0]!.pinned).toBe(true);
  });
  test("firstLooseIndex reports the boundary", () => {
    expect(firstLooseIndex(make("*a,*b,c,d"))).toBe(2);
    expect(firstLooseIndex(make("a,b"))).toBe(0);
    expect(firstLooseIndex(make("*a,*b"))).toBe(2);
  });
});
