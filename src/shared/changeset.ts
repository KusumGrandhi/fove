/**
 * What changed on disk during a turn.
 *
 * The other half of the boundary. `turns.ts` says *when* a turn ran; this says
 * what the working tree looked like before and after, and what the difference
 * between those two states means.
 *
 * The reason this is a comparison rather than a reading of `git status`: a file
 * that was already dirty when the turn started is not the turn's doing. Showing
 * it as one would be the difference between "here is what just happened" and
 * "here is everything uncommitted", and the second is what the git pane already
 * does.
 *
 * **Attribution is a heuristic and the vocabulary here says so.** A change that
 * appeared between two snapshots was made *during* the turn, by something. That
 * something is usually the agent and sometimes you, a formatter, a watcher, or
 * an agent in another pane. Nothing in this module claims authorship, and the
 * UI above it must not either.
 */

/** One file's state in a snapshot, reduced to what a comparison needs. */
export interface FileState {
  path: string;
  /** Combined index+worktree status: "M", "A", "D", "R", "?" (untracked). */
  status: string;
  /**
   * Content hash when the file was read, for detecting a change that leaves
   * the status letter identical -- an already-modified file modified again.
   */
  hash?: string;
}

export interface TreeSnapshot {
  /** HEAD at the time, so a commit during the turn is detectable. */
  head?: string;
  takenAt: number;
  files: FileState[];
}

/** How a file's state differs between two snapshots. */
export type ChangeKind =
  /** Not present before, present after. */
  | "added"
  /** Present in both, contents differ. */
  | "modified"
  /** Present before, gone after -- reverted, committed, or deleted. */
  | "resolved"
  /** Dirty before and still dirty, with no detectable change. */
  | "unchanged";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** Status letter after the turn, or before it for a resolved file. */
  status: string;
  /** True when the file was already dirty before the turn started. */
  preexisting: boolean;
}

export interface ChangeSet {
  /** Files whose state moved during the window. Excludes "unchanged". */
  changed: FileChange[];
  /**
   * Files that were dirty throughout and did not move.
   *
   * Kept rather than dropped because they are the honest caveat: they were
   * already in flight, so anything the turn did to them cannot be separated
   * from what was there before.
   */
  carried: FileChange[];
  /** True when HEAD moved, i.e. something committed mid-turn. */
  committed: boolean;
  /** HEAD before and after, when known. */
  headBefore?: string;
  headAfter?: string;
}

/**
 * Compare two snapshots of a working tree.
 *
 * Ordering of the result is by risk, not alphabet: additions and deletions
 * first, then modifications, then everything else. A new file and a removed one
 * are the changes most likely to be wrong and least likely to be noticed in a
 * long list.
 */
export function compareSnapshots(before: TreeSnapshot, after: TreeSnapshot): ChangeSet {
  const beforeByPath = new Map(before.files.map((f) => [f.path, f]));
  const afterByPath = new Map(after.files.map((f) => [f.path, f]));

  const changed: FileChange[] = [];
  const carried: FileChange[] = [];

  for (const file of after.files) {
    const prior = beforeByPath.get(file.path);

    if (!prior) {
      /*
       * Newly dirty. That is not the same as a new *file*: a tracked file that
       * was committed and clean before the turn also appears here, and calling
       * it "new" would render as NEW against a file that has existed for years.
       *
       * Git's own status letter is the authority -- "?" is untracked and "A" is
       * added to the index; anything else is an edit to something that already
       * existed.
       */
      const isNewFile = file.status.includes("?") || file.status.includes("A");
      changed.push({
        path: file.path,
        kind: isNewFile ? "added" : "modified",
        status: file.status,
        preexisting: false,
      });
      continue;
    }

    // Present in both. A hash difference is a real edit; without hashes, a
    // changed status letter is the only signal available.
    const moved =
      file.hash !== undefined && prior.hash !== undefined
        ? file.hash !== prior.hash
        : file.status !== prior.status;

    /*
     * An untracked file that moved is still a new file, not an edit. It landed
     * before this window opened and was changed inside it -- rendering that as
     * EDITED against a file git has never seen reads as a lie, even though the
     * underlying facts are right.
     */
    const isUntracked = file.status.includes("?");
    const entry: FileChange = {
      path: file.path,
      kind: moved ? (isUntracked ? "added" : "modified") : "unchanged",
      status: file.status,
      preexisting: true,
    };
    (moved ? changed : carried).push(entry);
  }

  // Present before, gone after: reverted, committed, or deleted from disk.
  // Worth surfacing -- work disappearing during a turn is exactly the kind of
  // thing you want to be told about rather than discover later.
  for (const file of before.files) {
    if (afterByPath.has(file.path)) continue;
    changed.push({
      path: file.path,
      kind: "resolved",
      status: file.status,
      preexisting: true,
    });
  }

  return {
    changed: changed.sort(byRisk),
    carried: carried.sort((a, b) => a.path.localeCompare(b.path)),
    committed: Boolean(before.head && after.head && before.head !== after.head),
    headBefore: before.head,
    headAfter: after.head,
  };
}

/**
 * Risk order: new and removed files first, then edits, then the rest.
 *
 * A new file is unreviewed by definition and a deletion is the hardest change
 * to notice by skimming, so both sort above a modification. Untracked files
 * rank with additions because that is what they are.
 */
const KIND_RANK: Record<ChangeKind, number> = {
  added: 0,
  resolved: 1,
  modified: 2,
  unchanged: 3,
};

function byRisk(a: FileChange, b: FileChange): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank;
  // A file that was clean before the turn is more clearly the turn's doing
  // than one that was already in flight, so it sorts first.
  if (a.preexisting !== b.preexisting) return a.preexisting ? 1 : -1;
  return a.path.localeCompare(b.path);
}

/**
 * A one-line summary of what a change set contains.
 *
 * Deliberately says "changed", never "the agent changed": see the module note.
 */
export function summarise(set: ChangeSet): string {
  const n = set.changed.length;
  if (n === 0) return set.carried.length > 0 ? "no files changed" : "nothing changed";

  const added = set.changed.filter((c) => c.kind === "added").length;
  const gone = set.changed.filter((c) => c.kind === "resolved").length;
  const parts = [`${n} file${n === 1 ? "" : "s"} changed`];
  if (added) parts.push(`${added} new`);
  if (gone) parts.push(`${gone} resolved`);
  if (set.committed) parts.push("committed during the turn");
  return parts.join(" · ");
}

/**
 * How much of the change set is muddied by work that was already in flight.
 *
 * Surfaced rather than hidden: when most of a turn's files were already dirty,
 * the boundary is telling you much less than it appears to, and the UI should
 * say so instead of presenting a confident list.
 */
export function confidence(set: ChangeSet): {
  clean: number;
  muddied: number;
  reliable: boolean;
} {
  const clean = set.changed.filter((c) => !c.preexisting).length;
  const muddied = set.changed.length - clean + set.carried.length;
  // Arbitrary but stated: more in-flight files than clean ones means the
  // attribution is weak enough to warn about.
  return { clean, muddied, reliable: muddied <= clean };
}
