/**
 * Commit-graph layout: turn a list of commits into lanes that can be drawn.
 *
 * Pure data and pure functions, free of React and Electron, for the same
 * reason the pane layout engine is: assigning lanes across merges and branch
 * points is fiddly, and it is far easier to prove here than through a UI.
 *
 * The input is the commit list from `GitWriteService.log()`, newest first,
 * with real parent hashes. We deliberately do not parse git's own `--graph`
 * ASCII art: that would mean reconstructing a DAG from drawing characters,
 * when the parent list already *is* the DAG.
 *
 * The algorithm is the standard one used by graph viewers: walk commits newest
 * to oldest holding a set of "open" lanes, each of which is waiting for a
 * particular commit hash. A commit takes the leftmost lane waiting for it (or
 * a fresh one if nothing is), then hands its lane to its first parent and
 * opens new lanes for the rest.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphRow<T extends GraphCommit = GraphCommit> {
  commit: T;
  /** Horizontal position of this commit's dot. */
  lane: number;
  /**
   * Lines passing through this row, including the one ending at the dot.
   * `from` and `to` are lane indices; a diagonal has `from !== to`.
   */
  edges: GraphEdge[];
  /** Widest lane index in use on this row, for sizing the gutter. */
  width: number;
}

export interface GraphEdge {
  from: number;
  to: number;
  /** The commit this line is travelling towards. */
  target: string;
  /** True when this edge terminates at the current row's dot. */
  ends: boolean;
}

/**
 * Assign lanes to commits.
 *
 * `commits` must be newest-first, as `git log` returns them. Commits whose
 * parents are outside the window (because the log was truncated) simply end
 * their lane, which is what a partial history should look like.
 */
export function layout<T extends GraphCommit>(commits: T[]): GraphRow<T>[] {
  /** Lane slots; each holds the hash that lane is currently waiting for. */
  const lanes: (string | null)[] = [];
  const rows: GraphRow<T>[] = [];

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // The lane reserved for this commit, if an earlier child opened one.
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // A head: nothing was waiting for it, so it starts its own lane.
      lane = firstFree();
    }

    const edges: GraphEdge[] = [];

    // Lines that pass straight through this row, untouched by this commit.
    for (let i = 0; i < lanes.length; i++) {
      const waiting = lanes[i] ?? null;
      if (waiting === null || i === lane) continue;
      if (waiting === commit.hash) {
        // Another lane was also waiting for this commit: it merges inward.
        edges.push({ from: i, to: lane, target: commit.hash, ends: true });
        lanes[i] = null;
      } else {
        edges.push({ from: i, to: i, target: waiting, ends: false });
      }
    }

    // This commit's own lane terminates at the dot.
    edges.push({ from: lane, to: lane, target: commit.hash, ends: true });

    // Hand the lane to the first parent; branch the rest into free lanes.
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    if (first) edges.push({ from: lane, to: lane, target: first, ends: false });

    for (const parent of rest) {
      // A parent already in flight keeps its lane rather than opening another.
      const existing = lanes.indexOf(parent);
      const target = existing !== -1 ? existing : firstFree();
      lanes[target] = parent;
      edges.push({ from: lane, to: target, target: parent, ends: false });
    }

    // Trailing empty lanes would inflate the gutter for every later row.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      commit,
      lane,
      edges,
      width: Math.max(lane, ...edges.map((e) => Math.max(e.from, e.to))),
    });
  }

  return rows;
}

/** Widest lane used anywhere, for sizing the graph gutter once. */
export function graphWidth(rows: GraphRow[]): number {
  return rows.reduce((w, r) => Math.max(w, r.width), 0) + 1;
}

/**
 * A stable colour index per lane.
 *
 * Colour follows the lane rather than the branch: a branch has no identity in
 * the commit list, and re-colouring on every row would make the graph flicker
 * as lanes are recycled.
 */
export const laneColor = (lane: number, palette: number): number => lane % palette;
