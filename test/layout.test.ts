import { expect, test, describe } from "bun:test";
import { fit } from "../src/panes/AgentTree.tsx";
import { laneFor } from "../src/panes/AgentTimeline.tsx";
import type { AgentNode } from "../src/data/types.ts";

describe("fit", () => {
  test("pads short strings to exactly w", () => {
    expect(fit("abc", 6)).toBe("abc   ");
    expect(fit("abc", 6)).toHaveLength(6);
  });
  test("truncates long strings to exactly w, with an ellipsis", () => {
    expect(fit("abcdefghij", 5)).toBe("abcd…");
    expect(fit("abcdefghij", 5)).toHaveLength(5);
  });
  test("never exceeds w for any input", () => {
    const long = "general-purpose · Adjudicate batch 07 with a very long tail";
    for (const w of [1, 5, 12, 40, 80]) expect(fit(long, w)).toHaveLength(w);
  });
  test("degenerate widths do not throw", () => {
    expect(fit("x", 0)).toBe("");
    expect(fit("x", -3)).toBe("");
  });
});

describe("tree row budget", () => {
  // Mirrors the column arithmetic in AgentTreeView: a row must never exceed
  // the terminal width, or OpenTUI wraps it and the layout collapses.
  const META = 13 + 8 + 9 + 7;
  const rowLen = (total: number, depth: number) => {
    const indent = "  ".repeat(Math.max(0, depth));
    const nameW = Math.max(12, total - META - indent.length - 3);
    // " " + indent + glyph(1) + " " + name + model(13) + dur(8) + tok(9) + tools(7)
    return 1 + indent.length + 1 + 1 + nameW + META;
  };
  test("fits within the terminal at common widths and depths", () => {
    for (const w of [80, 100, 120, 160, 200]) {
      for (const d of [0, 1, 2, 3]) {
        expect(rowLen(w, d)).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe("timeline row budget", () => {
  const labelW = 24, metaW = 17;
  test("label + lane + meta fits exactly within width", () => {
    for (const w of [80, 100, 120, 160]) {
      const cells = Math.max(10, w - labelW - metaW - 1);
      const node: AgentNode = { id: "x", parentId: "root", name: "n", status: "done",
        startedAt: 0, endedAt: 10, usage: {}, toolCalls: [], transcript: [],
        filesTouched: new Set(), depth: 1 };
      // " " + label(labelW-2) + lane(cells) + meta(metaW)
      const total = 1 + (labelW - 2) + laneFor(node, 0, 10, cells).length + metaW;
      expect(total).toBeLessThanOrEqual(w);
    }
  });
});
