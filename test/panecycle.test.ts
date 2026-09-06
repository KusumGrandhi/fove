import { expect, test, describe } from "bun:test";

/** Mirrors the ctrl+t cycle in main.tsx. */
type Pane = "chat" | "grid" | "tree" | "timeline";
const next = (v: Pane): Pane =>
  v === "chat" ? "grid" : v === "grid" ? "tree" : v === "tree" ? "timeline" : "chat";

describe("pane cycle", () => {
  test("visits every pane and returns to the start", () => {
    const seen: Pane[] = [];
    let p: Pane = "chat";
    for (let i = 0; i < 4; i++) { seen.push(p); p = next(p); }
    expect(seen).toEqual(["chat", "grid", "tree", "timeline"]);
    expect(p).toBe("chat");
  });
  test("grid comes immediately after chat -- it is the primary view", () => {
    expect(next("chat")).toBe("grid");
  });
  test("the cycle is total: no pane is a dead end", () => {
    for (const p of ["chat", "grid", "tree", "timeline"] as Pane[]) {
      expect(["chat", "grid", "tree", "timeline"]).toContain(next(p));
    }
  });
});
