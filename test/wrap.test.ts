import { expect, test, describe } from "bun:test";
import { wrap } from "../src/panes/Conversation.tsx";

describe("wrap", () => {
  test("wraps on word boundaries", () => {
    expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });
  test("never exceeds the width", () => {
    const text = "a ".repeat(200) + "supercalifragilisticexpialidocious";
    for (const w of [10, 20, 40, 80]) {
      for (const line of wrap(text, w)) expect(line.length).toBeLessThanOrEqual(w);
    }
  });
  test("hard-splits a word longer than the width", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  test("preserves explicit newlines as blank lines", () => {
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
  test("degenerate widths do not throw", () => {
    expect(wrap("hello", 0)).toEqual([]);
    expect(wrap("hello", -5)).toEqual([]);
  });
  test("collapses runs of whitespace", () => {
    expect(wrap("a     b", 10)).toEqual(["a b"]);
  });
});
