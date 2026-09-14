/**
 * A line-level diff, for the change bars in the editor's gutter.
 *
 * Monaco computes diffs in a worker, but only as part of a diff *editor* --
 * there is no public "just tell me what changed" call, and standing up a
 * hidden diff editor per open file to read its line changes would cost two
 * more editors and a worker round-trip on every keystroke.
 *
 * So: a small diff of our own, shaped for exactly this job. It runs against
 * the live buffer as you type, which sets the constraints -- it has to be
 * fast on the common edit (a few lines changed in a large file) and it must
 * never be slow enough to be felt, even on a file where the answer is hard.
 *
 * The strategy is the usual one, and the fast path is what actually matters:
 *
 *   1. trim the common prefix and suffix. Editing line 400 of a 900-line file
 *      leaves a middle of one line against one line, which is the whole
 *      computation for nearly every edit anyone makes.
 *   2. diff what is left with an LCS table.
 *   3. above a size cap, stop trying: report the middle as one modified block.
 *      A wrong-but-instant answer at that scale is a gutter that stays
 *      responsive, and the block it marks is genuinely all changed.
 */

export interface LineChanges {
  /** 1-based lines in the modified text that are new. */
  added: number[];
  /** 1-based lines in the modified text that replaced something. */
  modified: number[];
  /**
   * 1-based lines in the modified text with deleted lines *above* them, and
   * what was deleted. Line 0 means the deletion was at the top of the file.
   */
  deleted: { line: number; text: string[] }[];
}

/**
 * Beyond this many lines on either side of the trimmed middle, fall back to
 * "all of it changed" rather than filling a table of a million cells on a
 * keystroke. Large genuinely-unrelated texts are the only thing that reaches
 * it -- pasting a whole new file over an old one, or the first render of a
 * file that git has no version of.
 */
const MAX_LCS = 600;

const split = (text: string): string[] => text.split("\n");

export function lineChanges(original: string, modified: string): LineChanges {
  const empty: LineChanges = { added: [], modified: [], deleted: [] };
  if (original === modified) return empty;

  const a = split(original);
  const b = split(modified);

  // A file with no previous version is entirely new, and marking every line
  // as added is both true and useless -- the gutter would be a solid bar.
  if (original === "") return empty;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);

  if (aMid.length === 0 && bMid.length === 0) return empty;

  // Pure insertion or pure deletion: no table needed, and both are common.
  if (aMid.length === 0) {
    return { added: range(head + 1, bMid.length), modified: [], deleted: [] };
  }
  if (bMid.length === 0) {
    return { added: [], modified: [], deleted: [{ line: head, text: aMid }] };
  }

  if (aMid.length > MAX_LCS || bMid.length > MAX_LCS) {
    return {
      added: [],
      modified: range(head + 1, bMid.length),
      deleted: aMid.length > bMid.length
        ? [{ line: head + bMid.length, text: aMid.slice(bMid.length) }]
        : [],
    };
  }

  return fromOps(alignOps(aMid, bMid), aMid, head);
}

/** 1-based line numbers, `count` of them, starting at `from`. */
function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

type Op = "same" | "add" | "del";

/**
 * The edit script taking `a` to `b`, as a flat list walked in output order.
 *
 * A plain LCS table: O(n·m), which the size cap above keeps bounded. The
 * table holds lengths, so an Int32Array is enough and avoids allocating a
 * row of boxed numbers per line.
 */
function alignOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push("same"); i++; j++; }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + (j + 1)]!) { ops.push("del"); i++; }
    else { ops.push("add"); j++; }
  }
  while (i < n) { ops.push("del"); i++; }
  while (j < m) { ops.push("add"); j++; }
  return ops;
}

/**
 * Turn the edit script into gutter marks.
 *
 * The one judgement here: a run of deletions immediately followed by a run of
 * additions is a *modification*, not both. That is what the edit actually was,
 * and showing it as a red mark next to a green one for the same change reads
 * as twice as much churn as there is.
 */
function fromOps(ops: Op[], aMid: string[], head: number): LineChanges {
  const out: LineChanges = { added: [], modified: [], deleted: [] };
  // Lines consumed so far, in each text, offset to the full file.
  let aLine = head;
  let bLine = head;

  for (let k = 0; k < ops.length;) {
    if (ops[k] === "same") { aLine++; bLine++; k++; continue; }

    const dels: string[] = [];
    while (ops[k] === "del") { dels.push(aMid[aLine - head]!); aLine++; k++; }
    let adds = 0;
    while (ops[k] === "add") { adds++; k++; }

    // Pair them off: the overlap is a modification, the remainder is whichever
    // side was longer.
    const paired = Math.min(dels.length, adds);
    for (let p = 0; p < paired; p++) out.modified.push(bLine + p + 1);
    if (adds > paired) {
      for (let p = paired; p < adds; p++) out.added.push(bLine + p + 1);
    }
    if (dels.length > paired) {
      out.deleted.push({ line: bLine + adds, text: dels.slice(paired) });
    }
    bLine += adds;
  }

  return out;
}
