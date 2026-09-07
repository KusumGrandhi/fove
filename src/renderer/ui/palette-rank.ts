/**
 * Filtering and ranking for the command palette.
 *
 * Subsequence matching, not substring: typing `cpt` should find
 * `core-python-tests`, which is the whole reason a palette beats a dropdown.
 *
 * Ranking matters more than it looks. With a dozen worktrees and twenty
 * commands, "the right thing is first" is the difference between a palette and
 * a list you still have to read. The rules, in order of weight: a prefix match
 * beats a scattered one, a match on a word boundary beats one mid-word, and a
 * tighter span beats a spread-out one.
 */

export interface Badge {
  text: string;
  /** A CSS colour, for status that should read at a glance. */
  tone?: string;
}

export interface Item {
  id: string;
  label: string;
  /** Extra text that should also match the query, e.g. a full path. */
  keywords?: string;
  detail?: string;
  icon?: string;
  hint?: string;
  badges?: Badge[];
  /** Sorts before anything with a lower priority, regardless of score. */
  priority?: number;
  run: () => void;
}

interface Scored {
  item: Item;
  score: number;
  index: number;
}

/**
 * Score one candidate against a query, or null when it does not match.
 *
 * Higher is better. Returns 0 for an empty query so the caller keeps the
 * original order rather than shuffling an unfiltered list.
 */
export function score(text: string, query: string): number | null {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();

  // An exact prefix is what the user almost always means.
  if (hay.startsWith(needle)) return 1000 - hay.length;

  const at = hay.indexOf(needle);
  if (at >= 0) {
    // Contiguous, and better if it starts a word.
    return 700 - at + (at === 0 || isBoundary(hay[at - 1]!) ? 60 : 0);
  }

  // Scattered subsequence: every query character in order, anywhere.
  let i = 0;
  let first = -1;
  let last = -1;
  let boundaries = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] !== needle[i]) continue;
    if (first < 0) first = j;
    last = j;
    if (j === 0 || isBoundary(hay[j - 1]!)) boundaries++;
    i++;
  }
  if (i < needle.length) return null;

  // A tight span means the matched characters sit together rather than being
  // scraped from across the whole string.
  const span = last - first + 1;
  return 400 - span + boundaries * 25 - first;
}

function isBoundary(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "." || ch === ":";
}

/**
 * The items matching `query`, best first.
 *
 * Ties break on the original order, so a caller's deliberate arrangement (the
 * current worktree first, say) survives an empty or ambiguous query.
 */
export function rank(items: readonly Item[], query: string): Item[] {
  const out: Scored[] = [];
  items.forEach((item, index) => {
    const label = score(item.label, query);
    // Keywords match at a discount: a hit on the full path is real, but a hit
    // on the visible label is a better answer to what was typed.
    const keyword = item.keywords ? score(item.keywords, query) : null;
    const best =
      label === null ? (keyword === null ? null : keyword - 200)
        : keyword === null ? label
          : Math.max(label, keyword - 200);
    if (best === null) return;
    out.push({ item, score: best, index });
  });

  out.sort((a, b) => {
    const pa = a.item.priority ?? 0;
    const pb = b.item.priority ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  return out.map((s) => s.item);
}
