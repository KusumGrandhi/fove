import { expect, test, describe } from "bun:test";
import { treeRow } from "../src/panes/AgentTree.tsx";
import { fit } from "../src/panes/theme.ts";
import type { AgentNode } from "../src/data/types.ts";

const node = (over: Partial<AgentNode> = {}): AgentNode => ({
  id: "x", parentId: "root",
  name: "general-purpose", label: "Adjudicate batch 07 with an unusually long description",
  model: "claude-sonnet-5", status: "done", startedAt: 0, endedAt: 402_000,
  usage: { input_tokens: 828_200 }, toolCalls: Array(9).fill({ id: "t", name: "Bash" }),
  transcript: [], filesTouched: new Set(), depth: 1, ...over,
});

describe("row clipping", () => {
  test("a tree row never exceeds the terminal width", () => {
    for (const w of [60, 80, 100, 120, 160, 200]) {
      const r = treeRow(node(), w);
      const painted = r.name.length + 1 + fit(r.meta, Math.max(0, w - r.name.length - 1)).length;
      expect(painted).toBeLessThanOrEqual(w);
    }
  });
  test("deep nesting still fits", () => {
    for (const d of [0, 1, 2, 4, 8]) {
      const w = 100;
      const r = treeRow(node({ depth: d }), w);
      const painted = r.name.length + 1 + fit(r.meta, Math.max(0, w - r.name.length - 1)).length;
      expect(painted).toBeLessThanOrEqual(w);
    }
  });
  test("very long labels are truncated, not wrapped", () => {
    const r = treeRow(node({ label: "x".repeat(500) }), 100);
    expect(r.meta.length).toBeLessThanOrEqual(100);
    expect(r.meta).toContain("…");
  });
});
