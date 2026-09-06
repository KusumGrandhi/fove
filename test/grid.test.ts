import { expect, test, describe } from "bun:test";
import { tileLayout, tileLines } from "../src/panes/AgentGrid.tsx";
import type { AgentNode, TranscriptEntry } from "../src/data/types.ts";

const node = (entries: TranscriptEntry[], over: Partial<AgentNode> = {}): AgentNode => ({
  id: "a", parentId: "root", name: "general-purpose", label: "batch 07",
  status: "running", startedAt: 0, endedAt: 1000, usage: { input_tokens: 100 },
  toolCalls: [], transcript: entries, filesTouched: new Set(), depth: 1, ...over,
});

describe("tileLayout", () => {
  test("one agent gets the full width", () => {
    expect(tileLayout(1, 120, 30)).toMatchObject({ cols: 1, rows: 1, tileW: 120 });
  });
  test("2-4 agents tile two across", () => {
    for (const n of [2, 3, 4]) expect(tileLayout(n, 120, 30).cols).toBe(2);
    expect(tileLayout(4, 120, 30).rows).toBe(2);
  });
  test("5+ agents tile three across", () => {
    expect(tileLayout(6, 150, 30)).toMatchObject({ cols: 3, rows: 2 });
  });
  test("collapses columns rather than rendering unreadably narrow tiles", () => {
    // 60 cols / 3 would be 20 -- below the 28-col floor, so it must reduce.
    expect(tileLayout(6, 60, 30).tileW).toBeGreaterThanOrEqual(28);
    expect(tileLayout(6, 40, 30).cols).toBe(1);
  });
  test("tiles never exceed the available width", () => {
    for (const n of [1, 2, 5, 9]) {
      for (const w of [40, 80, 120, 200]) {
        const l = tileLayout(n, w, 30);
        expect(l.tileW * l.cols).toBeLessThanOrEqual(w);
      }
    }
  });
  test("degenerate counts do not throw", () => {
    expect(tileLayout(0, 80, 24).cols).toBe(1);
  });
});

describe("tileLines", () => {
  const entries = (n: number): TranscriptEntry[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "text" as const, text: `line ${i}` }));

  test("keeps the NEWEST content when the tile overflows", () => {
    const lines = tileLines(node(entries(50)), 40, 8);
    expect(lines.length).toBeLessThanOrEqual(6); // h - 2 for header+rule
    expect(lines.at(-1)!.text).toContain("line 49");
    expect(lines.some((l) => l.text.includes("line 0"))).toBe(false);
  });
  test("marks thinking blocks so they can be coloured differently", () => {
    const lines = tileLines(node([{ kind: "thinking", text: "pondering" }]), 40, 6);
    expect(lines[0]!.kind).toBe("thinking");
    expect(lines[0]!.text).toContain("◇");
  });
  test("marks tool calls", () => {
    const lines = tileLines(node([{ kind: "tool_use", text: "Bash" }]), 40, 6);
    expect(lines[0]!.text).toContain("⚙");
  });
  test("never emits a line wider than the tile", () => {
    const long = [{ kind: "text" as const, text: "x".repeat(500) }];
    for (const w of [30, 60, 100]) {
      for (const l of tileLines(node(long), w, 10)) expect(l.text.length).toBeLessThanOrEqual(w - 2);
    }
  });
  test("a tile too short for a body returns nothing rather than throwing", () => {
    expect(tileLines(node(entries(5)), 40, 2)).toEqual([]);
    expect(tileLines(node(entries(5)), 40, 0)).toEqual([]);
  });
  test("an empty agent renders no lines", () => {
    expect(tileLines(node([]), 40, 10)).toEqual([]);
  });
});
