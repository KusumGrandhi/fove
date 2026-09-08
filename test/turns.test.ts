/**
 * Turn boundaries.
 *
 * The property that matters is not "does it split" but "does it split into the
 * right *number*". On a real transcript there are 3,252 records with
 * `role: "user"` and only ~191 typed prompts; a naive split produces three
 * thousand empty turns, and every one of them would render in Keel as a turn
 * that changed nothing.
 *
 * So most of these tests are about what is *not* a turn.
 */

import { describe, expect, it } from "vitest";
import {
  promptText, splitTurns, latestTurn, looksFinished, timeOf, type TurnRecord,
} from "../src/shared/turns.js";

const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const userText = (text: string, n: number, extra: Partial<TurnRecord> = {}): TurnRecord => ({
  type: "user",
  uuid: `u${n}`,
  timestamp: at(n),
  message: { role: "user", content: text },
  ...extra,
});

const toolResult = (n: number): TurnRecord => ({
  type: "user",
  uuid: `tr${n}`,
  timestamp: at(n),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
  },
});

const assistant = (n: number): TurnRecord => ({
  type: "assistant",
  uuid: `a${n}`,
  timestamp: at(n),
  message: { role: "assistant", content: [{ type: "text", text: "working" }] },
});

describe("promptText", () => {
  it("reads a plain string prompt", () => {
    expect(promptText(userText("fix the parser", 1))).toBe("fix the parser");
  });

  it("reads text blocks from an array", () => {
    expect(promptText({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "  do the thing  " }] },
    })).toBe("do the thing");
  });

  it("rejects a tool result", () => {
    // The big one: 3,034 of 3,252 user records in a real transcript are these.
    expect(promptText(toolResult(1))).toBeNull();
  });

  it("rejects a tool result even when a text block sits beside it", () => {
    expect(promptText({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "x", content: "ok" },
          { type: "text", text: "here is the output" },
        ],
      },
    })).toBeNull();
  });

  it("rejects subagent traffic", () => {
    expect(promptText(userText("subagent prompt", 1, { isSidechain: true }))).toBeNull();
  });

  it("rejects injected context", () => {
    expect(promptText(userText("<system-reminder>", 1, { isMeta: true }))).toBeNull();
  });

  it("rejects the CLI's own synthetic prompts", () => {
    // Written by the CLI on an interrupt; identical in shape to a real prompt,
    // so it can only be matched by value.
    expect(promptText(userText("[Request interrupted by user]", 1))).toBeNull();
    expect(promptText(userText("  [Request interrupted by user]  ", 2))).toBeNull();
  });

  it("keeps a prompt that merely mentions one", () => {
    // The match is on the whole string, so this stays a real turn.
    const p = "why do I keep seeing [Request interrupted by user]?";
    expect(promptText(userText(p, 1))).toBe(p);
  });

  it("rejects slash-command machinery", () => {
    /*
     * Found by running this over a real transcript: it reported nine
     * *unfinished* turns when at most one can be live. All nine were `/compact`
     * -- the invocation, its stdout, and the continuation preamble -- each of
     * which looks exactly like a typed prompt and would render in Keel as a
     * turn that changed nothing.
     */
    expect(promptText(userText("<command-name>/compact</command-name>", 1))).toBeNull();
    expect(promptText(userText("<local-command-stdout>Compacted </local-command-stdout>", 2))).toBeNull();
    expect(promptText(userText(
      "This session is being continued from a previous conversation that ran out of context.", 3,
    ))).toBeNull();
    expect(promptText(userText("<system-reminder>be careful</system-reminder>", 4))).toBeNull();
  });

  it("keeps a prompt that only mentions a slash command", () => {
    // Prefix match, so this stays a real turn -- asking *about* /compact is a
    // question, not an invocation.
    const p = "why does /compact lose my context?";
    expect(promptText(userText(p, 1))).toBe(p);
  });

  it("rejects an empty or whitespace prompt", () => {
    expect(promptText(userText("   ", 1))).toBeNull();
  });

  it("rejects a non-user record", () => {
    expect(promptText(assistant(1))).toBeNull();
  });

  it("does not throw on a malformed record", () => {
    expect(promptText({} as TurnRecord)).toBeNull();
    expect(promptText({ type: "user" })).toBeNull();
    expect(promptText({ type: "user", message: null })).toBeNull();
    expect(promptText({ type: "user", message: { content: 42 as never } })).toBeNull();
  });
});

describe("splitTurns", () => {
  it("makes one turn per typed prompt, not per user record", () => {
    const records = [
      userText("first", 0),
      assistant(1),
      toolResult(2),
      assistant(3),
      toolResult(4),
      userText("second", 5),
      assistant(6),
    ];
    const turns = splitTurns(records);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.prompt)).toEqual(["first", "second"]);
  });

  it("attributes intervening records to the turn in progress", () => {
    const turns = splitTurns([
      userText("first", 0), assistant(1), toolResult(2), assistant(3),
      userText("second", 4), assistant(5),
    ]);
    expect(turns[0]!.recordCount).toBe(3);
    expect(turns[1]!.recordCount).toBe(1);
  });

  it("ends a turn at its last record, not at the next prompt", () => {
    // The gap between one turn ending and the next starting is thinking time,
    // and counting it would inflate every turn's duration.
    const turns = splitTurns([
      userText("first", 0), assistant(10),
      userText("second", 90),
    ]);
    expect(turns[0]!.endedAt).toBe(Date.parse(at(10)));
  });

  it("leaves a running turn without an end", () => {
    const turns = splitTurns([userText("go", 0)]);
    expect(turns[0]!.endedAt).toBeUndefined();
  });

  it("ignores records before the first prompt", () => {
    // A resumed session opens with metadata belonging to no turn.
    const turns = splitTurns([assistant(0), toolResult(1), userText("go", 2)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.recordCount).toBe(0);
  });

  it("skips a prompt with no usable timestamp", () => {
    // A turn that cannot be placed in time cannot be matched to a diff, so it
    // is dropped rather than given a fabricated start.
    const turns = splitTurns([
      { type: "user", uuid: "x", message: { role: "user", content: "no stamp" } },
      userText("real", 5),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toBe("real");
  });

  it("returns nothing for an empty transcript", () => {
    expect(splitTurns([])).toEqual([]);
  });

  it("does not let a stale timestamp move a turn's end backwards", () => {
    const turns = splitTurns([userText("go", 10), assistant(20), assistant(15)]);
    expect(turns[0]!.endedAt).toBe(Date.parse(at(20)));
  });
});

describe("latestTurn and looksFinished", () => {
  it("returns the newest turn", () => {
    const turns = splitTurns([userText("a", 0), userText("b", 5)]);
    expect(latestTurn(turns)!.prompt).toBe("b");
  });

  it("returns null with no turns", () => {
    expect(latestTurn([])).toBeNull();
  });

  it("treats a running turn as unfinished however long it has been", () => {
    const turns = splitTurns([userText("go", 0)]);
    expect(looksFinished(turns[0]!, Date.parse(at(0)) + 600_000)).toBe(false);
  });

  it("calls a turn finished only after it has been quiet", () => {
    const turns = splitTurns([userText("go", 0), assistant(1)]);
    const end = Date.parse(at(1));
    expect(looksFinished(turns[0]!, end + 1000)).toBe(false);
    expect(looksFinished(turns[0]!, end + 9000)).toBe(true);
  });
});

describe("timeOf", () => {
  it("parses a timestamp", () => {
    expect(timeOf({ timestamp: at(30) })).toBe(Date.parse(at(30)));
  });

  it("returns undefined rather than NaN for a bad one", () => {
    expect(timeOf({ timestamp: "not a date" })).toBeUndefined();
    expect(timeOf({})).toBeUndefined();
  });
});
