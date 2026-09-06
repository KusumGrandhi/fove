import { expect, test, describe } from "bun:test";
import { laneFor } from "../src/panes/AgentTimeline.tsx";
import type { AgentNode } from "../src/data/types.ts";

const node = (startedAt?: number, endedAt?: number): AgentNode => ({
  id: "x", parentId: "root", name: "a", status: "done",
  startedAt, endedAt, usage: {}, toolCalls: [], transcript: [],
  filesTouched: new Set(), depth: 1,
});

describe("laneFor", () => {
  test("bar spans the agent's share of the window", () => {
    // Agent runs the second half of a 0..100 window.
    expect(laneFor(node(50, 100), 0, 100, 10)).toBe("·····█████");
  });
  test("an agent covering the whole window fills the lane", () => {
    expect(laneFor(node(0, 100), 0, 100, 10)).toBe("██████████");
  });
  test("a zero-length agent still renders at least one cell", () => {
    const lane = laneFor(node(50, 50), 0, 100, 10);
    expect(lane).toHaveLength(10);
    expect(lane).toContain("█");
  });
  test("lane is always exactly `cells` wide", () => {
    for (const [s, e] of [[0, 1], [0, 100], [99, 100], [33, 66]] as const) {
      expect(laneFor(node(s, e), 0, 100, 24)).toHaveLength(24);
    }
  });
  test("out-of-window times are clamped, not overflowed", () => {
    expect(laneFor(node(-500, 5000), 0, 100, 8)).toHaveLength(8);
  });
  test("missing timestamps fall back to the full window", () => {
    expect(laneFor(node(undefined, undefined), 0, 100, 6)).toBe("██████");
  });
  test("two agents that did not overlap produce disjoint bars", () => {
    const a = laneFor(node(0, 40), 0, 100, 10);
    const b = laneFor(node(60, 100), 0, 100, 10);
    // No cell is a bar in both -- this is the serialization signal.
    const overlap = [...a].filter((ch, i) => ch === "█" && b[i] === "█");
    expect(overlap).toHaveLength(0);
  });
});
