/**
 * The tree as a worklist.
 *
 * Rule 1 of the handoff: *the tree is a worklist, not a directory*. Default
 * order is by attention — failing, then drifted, then changed in the last hour,
 * then everything else — with alphabetical and true-hierarchy available but
 * never the default.
 *
 * The reason this is a pure module: the ordering *is* the feature. A file tree
 * sorted by name is something every editor already has, and fove has one in the
 * editor pane. What makes this worth a column is that the top of it is the work,
 * and that ranking deserves to be provable rather than eyeballed.
 *
 * Quiet subtrees fold themselves away. On a repository the size of `core` a
 * directory nobody has touched in six weeks is forty rows of nothing between
 * you and the four that matter.
 */

/** What a file is doing that might want attention. */
export type Tone =
  /** A proven invariant broke, or errors crossed a threshold. */
  | "failing"
  /** Production contradicts an intent clause. */
  | "drifted"
  /** An agent holds a lease on this file right now. */
  | "active"
  /** Changed during the current or a recent turn. */
  | "changed"
  /** Nothing notable. */
  | "normal"
  /** Untouched long enough to fold away. */
  | "quiet";

export interface WorklistFile {
  /** Repo-relative path. */
  path: string;
  tone: Tone;
  /** Short right-aligned label: "agent here", "drifted", "1.1% err". */
  badge?: string;
  /** When it last changed, for the "last hour" band. Epoch ms. */
  touchedAt?: number;
}

export interface WorklistRow {
  kind: "dir" | "file";
  /** Full path for a file; the directory prefix for a dir row. */
  path: string;
  /** Just the segment to render. */
  name: string;
  depth: number;
  tone: Tone;
  badge?: string;
  /** Files hidden under a folded directory row. */
  folded?: number;
}

export type SortMode = "attention" | "alpha" | "hierarchy";

/**
 * Attention rank. Lower sorts first.
 *
 * The order is the handoff's, and each step is a claim about what you most
 * need to see: something broken, then something that drifted from its stated
 * intent, then whatever an agent is touching right now, then recent edits.
 */
const TONE_RANK: Record<Tone, number> = {
  failing: 0,
  drifted: 1,
  active: 2,
  changed: 3,
  normal: 4,
  quiet: 5,
};

/** A file changed within this window counts as "recent" for ordering. */
export const RECENT_MS = 60 * 60 * 1000;

/**
 * Order files by attention.
 *
 * Within a rank, recency breaks the tie, then path — so the list is stable
 * between renders rather than reshuffling as timestamps tick.
 */
export function byAttention(files: WorklistFile[], now = Date.now()): WorklistFile[] {
  return [...files].sort((a, b) => {
    const rank = TONE_RANK[a.tone] - TONE_RANK[b.tone];
    if (rank !== 0) return rank;

    // Recent first, but only within the hour window: beyond it, "changed three
    // days ago" and "changed five days ago" are the same thing and sorting by
    // them just makes the list unstable.
    const aRecent = a.touchedAt !== undefined && now - a.touchedAt < RECENT_MS;
    const bRecent = b.touchedAt !== undefined && now - b.touchedAt < RECENT_MS;
    if (aRecent !== bRecent) return aRecent ? -1 : 1;
    if (aRecent && bRecent) return (b.touchedAt ?? 0) - (a.touchedAt ?? 0);

    return a.path.localeCompare(b.path);
  });
}

/**
 * Build the rows to render.
 *
 * In attention order the tree is deliberately *flat* — a ranked list of files
 * with their full paths, because grouping by directory would reimpose exactly
 * the hierarchy the ranking exists to escape. Hierarchy mode restores the
 * folders for when you actually want to navigate rather than triage.
 */
export function buildRows(
  files: WorklistFile[],
  mode: SortMode = "attention",
  now = Date.now(),
): WorklistRow[] {
  if (mode === "alpha") {
    return [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => flatRow(f));
  }

  if (mode === "hierarchy") return hierarchyRows(files);

  return byAttention(files, now).map((f) => flatRow(f));
}

function flatRow(f: WorklistFile): WorklistRow {
  return {
    kind: "file",
    path: f.path,
    // Full path in a flat list: two files called `helpers.py` are otherwise
    // indistinguishable, and on a large repo there are many.
    name: f.path,
    depth: 0,
    tone: f.tone,
    badge: f.badge,
  };
}

/**
 * A real directory tree, with quiet subtrees folded.
 *
 * A directory whose files are all quiet collapses to one row carrying a count,
 * because forty rows of untouched code between you and the work is the thing
 * the worklist exists to prevent.
 */
function hierarchyRows(files: WorklistFile[]): WorklistRow[] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const rows: WorklistRow[] = [];
  const emitted = new Set<string>();

  // Group by immediate parent so a fully-quiet directory can be folded whole.
  const byDir = new Map<string, WorklistFile[]>();
  for (const f of sorted) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }

  for (const [dir, group] of byDir) {
    const allQuiet = group.every((f) => f.tone === "quiet");

    if (dir && allQuiet && group.length > 2) {
      rows.push({
        kind: "dir",
        path: dir,
        name: dir,
        depth: 0,
        tone: "quiet",
        folded: group.length,
        badge: `quiet · ${group.length}`,
      });
      continue;
    }

    // Emit the directory rows leading here, once each.
    const segments = dir ? dir.split("/") : [];
    segments.forEach((seg, i) => {
      const prefix = segments.slice(0, i + 1).join("/");
      if (emitted.has(prefix)) return;
      emitted.add(prefix);
      rows.push({ kind: "dir", path: prefix, name: seg, depth: i, tone: "normal" });
    });

    for (const f of group) {
      rows.push({
        kind: "file",
        path: f.path,
        name: f.path.slice(dir ? dir.length + 1 : 0),
        depth: segments.length,
        tone: f.tone,
        badge: f.badge,
      });
    }
  }

  return rows;
}

/**
 * How many rows are worth attention at all.
 *
 * Shown in the header so the column can say "4 of 312 need you" rather than
 * presenting 312 rows and leaving the counting to the reader.
 */
export function attentionCount(files: WorklistFile[]): number {
  return files.filter((f) => TONE_RANK[f.tone] <= TONE_RANK.changed).length;
}
