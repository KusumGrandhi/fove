import { expect, test, describe } from "bun:test";

/**
 * Mirrors the list-window arithmetic in main.tsx. The cursor must always be
 * visible, and the window must never run past either end of the list.
 */
const offsetFor = (n: number, rows: number, cursor: number) => {
  if (n <= rows) return 0;
  return Math.max(0, Math.min(n - rows, cursor - Math.floor(rows / 2)));
};
const visible = (n: number, rows: number, cursor: number) => {
  const off = offsetFor(n, rows, cursor);
  return { off, end: Math.min(n, off + rows) };
};

describe("session list scrolling", () => {
  test("no scrolling when everything fits", () => {
    expect(offsetFor(4, 10, 0)).toBe(0);
    expect(offsetFor(4, 10, 3)).toBe(0);
  });
  test("cursor stays within the visible window at every position", () => {
    const n = 105, rows = 12;
    for (let c = 0; c < n; c++) {
      const { off, end } = visible(n, rows, c);
      expect(c).toBeGreaterThanOrEqual(off);
      expect(c).toBeLessThan(end);
    }
  });
  test("window never runs past the end of the list", () => {
    const n = 105, rows = 12;
    for (let c = 0; c < n; c++) {
      const { off, end } = visible(n, rows, c);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(n);
      expect(end - off).toBe(Math.min(rows, n));
    }
  });
  test("the last item is reachable", () => {
    const n = 105, rows = 12;
    const { off, end } = visible(n, rows, n - 1);
    expect(end).toBe(n);
    expect(off).toBe(n - rows);
  });
  test("degenerate sizes do not throw or invert", () => {
    for (const rows of [1, 2, 3]) {
      const { off, end } = visible(105, rows, 50);
      expect(end).toBeGreaterThan(off);
    }
    expect(offsetFor(0, 10, 0)).toBe(0);
  });
});
