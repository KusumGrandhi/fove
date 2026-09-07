import { describe, expect, it } from "vitest";
import { rank, score, type Item } from "../src/renderer/ui/palette-rank.js";

const item = (label: string, extra: Partial<Item> = {}): Item =>
  ({ id: label, label, run: () => {}, ...extra });

describe("score", () => {
  it("returns 0 for an empty query, so an unfiltered list keeps its order", () => {
    expect(score("anything", "")).toBe(0);
  });

  it("matches a scattered subsequence", () => {
    // The reason a palette beats a dropdown.
    expect(score("core-python-tests", "cpt")).not.toBeNull();
  });

  it("rejects characters out of order", () => {
    expect(score("abc", "cb")).toBeNull();
  });

  it("rejects a character that is not present", () => {
    expect(score("abc", "abd")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(score("MyBranch", "mybranch")).not.toBeNull();
  });

  it("ranks a prefix above a mid-string match", () => {
    expect(score("core", "cor")!).toBeGreaterThan(score("my-core", "cor")!);
  });

  it("ranks a contiguous match above a scattered one", () => {
    expect(score("xcorex", "core")!).toBeGreaterThan(score("c-o-r-e", "core")!);
  });

  it("ranks a word-boundary match above one inside a word", () => {
    expect(score("my-core", "cor")!).toBeGreaterThan(score("mycore", "cor")!);
  });
});

describe("rank", () => {
  it("returns everything for an empty query, in the original order", () => {
    const items = [item("b"), item("a")];
    expect(rank(items, "").map((i) => i.label)).toEqual(["b", "a"]);
  });

  it("drops non-matches", () => {
    expect(rank([item("alpha"), item("beta")], "alp").map((i) => i.label)).toEqual(["alpha"]);
  });

  it("puts the best match first", () => {
    const items = [item("my-core-thing"), item("core")];
    expect(rank(items, "core")[0]!.label).toBe("core");
  });

  it("matches on keywords when the label does not", () => {
    const items = [item("AGENT", { keywords: "/a/.warp/worktrees/AGENT" })];
    expect(rank(items, "warp")).toHaveLength(1);
  });

  it("prefers a label match over a keyword match", () => {
    const byKeyword = item("zzz", { keywords: "core" });
    const byLabel = item("core");
    expect(rank([byKeyword, byLabel], "core")[0]!.label).toBe("core");
  });

  it("honours priority over score", () => {
    // The current worktree stays on top even when another scores higher.
    const items = [item("core"), item("my-core", { priority: 1 })];
    expect(rank(items, "core")[0]!.label).toBe("my-core");
  });

  it("breaks ties on the original order", () => {
    const items = [item("core-a"), item("core-b")];
    expect(rank(items, "core").map((i) => i.label)).toEqual(["core-a", "core-b"]);
  });
});
