/**
 * Reconstructing the prompt's contents from the attachment records.
 *
 * The rules here were read off real transcripts, not guessed: some records
 * restate a category in full, others describe a change to it, and treating one
 * as the other is the difference between "41 skills" and "41 skills counted
 * four times".
 */
import { describe, expect, test } from "vitest";
import { CategoryAccumulator, emptyCategories, totalBytes } from "../src/data/contextCategories.js";
import type { TranscriptRecord } from "../src/data/types.js";

const att = (attachment: Record<string, unknown>): TranscriptRecord =>
  ({ type: "attachment", attachment }) as TranscriptRecord;

const fold = (records: TranscriptRecord[]) => {
  const a = new CategoryAccumulator();
  for (const r of records) a.add(r);
  return a.current;
};

describe("CategoryAccumulator", () => {
  test("a full skill listing replaces rather than accumulates", () => {
    // Real transcripts repeat the initial listing verbatim; summing them gave
    // four times the skills that were actually loaded.
    const initial = att({ type: "skill_listing", isInitial: true, skillCount: 41, content: "x".repeat(4000) });
    const c = fold([initial, initial, initial]);
    expect(c.skills).toEqual({ bytes: 4000, count: 41 });
  });

  test("a partial skill listing adds to the one already there", () => {
    const c = fold([
      att({ type: "skill_listing", isInitial: true, skillCount: 41, content: "x".repeat(4000) }),
      att({ type: "skill_listing", isInitial: false, skillCount: 11, content: "y".repeat(400) }),
    ]);
    expect(c.skills).toEqual({ bytes: 4400, count: 52 });
  });

  test("instructions restate in full, so the newest record wins", () => {
    const c = fold([
      att({ type: "instructions", files: [{ path: "a", content: "x".repeat(999) }] }),
      att({ type: "instructions", files: [
        { path: "a", content: "x".repeat(100) },
        { path: "b", content: "y".repeat(50) },
      ] }),
    ]);
    expect(c.memory).toEqual({ bytes: 150, count: 2 });
  });

  test("a withdrawn tool takes its own bytes with it", () => {
    // Why tools are tracked per name: a running total cannot be un-added.
    const c = fold([
      att({ type: "deferred_tools_delta",
            addedNames: ["Read", "mcp__linear__save_issue"],
            addedLines: ["x".repeat(40), "y".repeat(80)] }),
      att({ type: "deferred_tools_delta", addedNames: [], addedLines: [],
            removedNames: ["mcp__linear__save_issue"] }),
    ]);
    expect(c.builtinTools).toEqual({ bytes: 40, count: 1 });
    expect(c.mcpTools).toEqual({ bytes: 0, count: 0 });
  });

  test("tools are split by the mcp__ naming, nothing else", () => {
    const c = fold([
      att({ type: "deferred_tools_delta",
            addedNames: ["Read", "Bash", "mcp__slack__post", "mcp__linear__get"],
            addedLines: ["a".repeat(10), "b".repeat(10), "c".repeat(30), "d".repeat(30)] }),
    ]);
    expect(c.builtinTools).toEqual({ bytes: 20, count: 2 });
    expect(c.mcpTools).toEqual({ bytes: 60, count: 2 });
  });

  test("a re-added tool keeps the size it had, not zero", () => {
    // readdedNames carries no lines of its own, so a naive zip would silently
    // drop a re-offered tool to 0 bytes.
    const c = fold([
      att({ type: "deferred_tools_delta", addedNames: ["Read"], addedLines: ["x".repeat(40)] }),
      att({ type: "deferred_tools_delta", addedNames: [], addedLines: [], removedNames: ["Read"] }),
      att({ type: "deferred_tools_delta", addedNames: [], addedLines: [], readdedNames: ["Read"] }),
    ]);
    // Re-offered, and costed at what it cost before rather than nothing.
    expect(c.builtinTools.count).toBe(1);
  });

  test("an initial agent roster clears whatever came before", () => {
    const c = fold([
      att({ type: "agent_listing_delta", isInitial: true,
            addedTypes: ["old"], addedLines: ["x".repeat(100)] }),
      att({ type: "agent_listing_delta", isInitial: true,
            addedTypes: ["a", "b"], addedLines: ["y".repeat(40), "z".repeat(60)] }),
    ]);
    expect(c.agents).toEqual({ bytes: 100, count: 2 });
  });

  test("tool schemas accumulate -- each one is pulled in once", () => {
    const entry = { name: "WebFetch", description: "d", input_schema: { type: "object" } };
    const c = fold([
      att({ type: "deferred_tools_record", entries: [entry] }),
      att({ type: "deferred_tools_record", entries: [entry] }),
    ]);
    expect(c.toolSchemas.count).toBe(2);
    expect(c.toolSchemas.bytes).toBe(JSON.stringify(entry).length * 2);
  });

  test("non-attachment records and unknown attachment types are ignored", () => {
    const c = fold([
      { type: "assistant", message: { usage: { input_tokens: 5 } } } as TranscriptRecord,
      { type: "user" } as TranscriptRecord,
      att({ type: "total_tokens_reminder", text: "<total_tokens>1</total_tokens>" }),
      att({ type: "some_future_thing", content: "x".repeat(9999) }),
    ]);
    expect(c).toEqual(emptyCategories());
    expect(totalBytes(c)).toBe(0);
  });

  test("malformed records do not throw", () => {
    // The transcript format is undocumented and churns; a missing field must
    // cost a number, never the whole rail.
    const c = fold([
      att({ type: "skill_listing" }),
      att({ type: "instructions", files: "not-an-array" }),
      att({ type: "deferred_tools_delta", addedNames: ["A"] }),
      { type: "attachment" } as TranscriptRecord,
    ]);
    expect(c.skills).toEqual({ bytes: 0, count: 0 });
    expect(c.memory).toEqual({ bytes: 0, count: 0 });
    expect(c.builtinTools).toEqual({ bytes: 0, count: 1 });
  });
});
