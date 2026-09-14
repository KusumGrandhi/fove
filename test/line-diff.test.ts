import { describe, expect, test } from "vitest";
import { lineChanges } from "../src/shared/line-diff.js";

const lines = (...l: string[]) => l.join("\n");

describe("lineChanges", () => {
  test("identical text has no marks", () => {
    expect(lineChanges(lines("a", "b"), lines("a", "b")))
      .toEqual({ added: [], modified: [], deleted: [] });
  });

  test("an inserted line is an addition at its own line number", () => {
    const r = lineChanges(lines("a", "c"), lines("a", "b", "c"));
    expect(r.added).toEqual([2]);
    expect(r.modified).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  test("a changed line is a modification, not an add plus a delete", () => {
    const r = lineChanges(lines("a", "b", "c"), lines("a", "B", "c"));
    expect(r.modified).toEqual([2]);
    expect(r.added).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  test("a deleted line is recorded above the line that follows it", () => {
    const r = lineChanges(lines("a", "b", "c"), lines("a", "c"));
    expect(r.deleted).toEqual([{ line: 1, text: ["b"] }]);
    expect(r.added).toEqual([]);
    expect(r.modified).toEqual([]);
  });

  test("a deletion at the top of the file is reported at line 0", () => {
    const r = lineChanges(lines("a", "b"), lines("b"));
    expect(r.deleted).toEqual([{ line: 0, text: ["a"] }]);
  });

  test("two lines replaced by three is two modifications and one addition", () => {
    const r = lineChanges(lines("x", "a", "b", "y"), lines("x", "A", "B", "C", "y"));
    expect(r.modified).toEqual([2, 3]);
    expect(r.added).toEqual([4]);
    expect(r.deleted).toEqual([]);
  });

  test("three lines replaced by one is one modification and a deletion", () => {
    const r = lineChanges(lines("x", "a", "b", "c", "y"), lines("x", "A", "y"));
    expect(r.modified).toEqual([2]);
    expect(r.deleted).toEqual([{ line: 2, text: ["b", "c"] }]);
  });

  test("appending to the end of a file marks only the new lines", () => {
    const r = lineChanges(lines("a", "b"), lines("a", "b", "c", "d"));
    expect(r.added).toEqual([3, 4]);
  });

  test("a file with no previous version is not marked line by line", () => {
    expect(lineChanges("", lines("a", "b", "c")))
      .toEqual({ added: [], modified: [], deleted: [] });
  });

  test("emptying a file leaves the one blank line a buffer always has", () => {
    // An empty editor is a file of one empty line, not of no lines -- so this
    // is "line 1 replaced, and the rest deleted", not a single deletion block.
    const r = lineChanges(lines("a", "b"), "");
    expect(r.modified).toEqual([1]);
    expect(r.deleted).toEqual([{ line: 1, text: ["b"] }]);
  });

  test("edits far apart are reported separately", () => {
    const before = lines("1", "2", "3", "4", "5", "6", "7");
    const after = lines("1", "TWO", "3", "4", "5", "SIX", "7");
    const r = lineChanges(before, after);
    expect(r.modified).toEqual([2, 6]);
  });

  test("a huge unrelated rewrite still answers, as one block", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
    const started = Date.now();
    const r = lineChanges(before, after);
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.modified.length).toBe(2000);
  });

  test("an edit inside a very large file takes the trimmed fast path", () => {
    const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const edited = [...base];
    edited[9999] = "changed";
    const started = Date.now();
    const r = lineChanges(base.join("\n"), edited.join("\n"));
    expect(Date.now() - started).toBeLessThan(200);
    expect(r.modified).toEqual([10000]);
  });
});
