/**
 * Starting layouts.
 *
 * A pane can go anywhere, which is the right freedom to have and the wrong
 * thing to hand someone on an empty workspace: every new tab began as a single
 * shell, so the first minute of every workspace was spent rebuilding the same
 * arrangement by hand.
 *
 * These are *starting points*, not modes. Nothing is locked; the moment a pane
 * is dragged the preset stops being a fact about the tab and becomes just the
 * shape it happened to start in.
 *
 * Pure data, no React and no Electron, so the tree shapes can be proved
 * directly -- the same reason the layout engine itself is a pure module.
 */

import { leaf, newId, type Branch, type Node } from "./layout.js";

/** Every pane type a preset can place. Mirrors `PaneKind` in the renderer. */
export type LayoutPaneKind =
  | "shell" | "claude" | "git" | "editor" | "agents"
  | "config" | "search" | "browser" | "debug";

export interface LayoutPreset {
  id: string;
  label: string;
  /** One line, shown under the label in the picker. */
  hint: string;
  /**
   * The panes to create, in the order the tree references them.
   *
   * The tree is built from indices into this list rather than from ids, so a
   * preset is plain data and the caller owns id generation.
   */
  panes: LayoutPaneKind[];
  /** Which pane starts focused, as an index into `panes`. */
  focus: number;
  /** Build the tree from pane ids, positionally matched to `panes`. */
  build: (ids: string[]) => Node;
}

/** A branch, with an explicit ratio: presets care about proportion. */
const branch = (dir: "row" | "column", ratio: number, a: Node, b: Node): Branch => ({
  kind: "branch",
  id: newId("b"),
  dir,
  ratio,
  a,
  b,
});

/**
 * The three presets.
 *
 * Ordered by how much screen they ask for, which is also roughly how much of
 * the app they use.
 */
export const PRESETS: LayoutPreset[] = [
  {
    id: "lite",
    label: "Lite",
    hint: "Claude and a shell. Nothing else competing for the screen.",
    /*
     * The smallest thing that is still fove rather than a terminal.
     *
     * Claude leads and takes the larger share because it is where the typing
     * happens; the shell is there for the commands you run *around* a turn --
     * a test, a git command, a quick look -- and does not need half the width
     * to do that.
     */
    panes: ["claude", "shell"],
    focus: 0,
    build: ([claude, shell]) =>
      branch("row", 0.62, leaf(claude!), leaf(shell!)),
  },

  {
    id: "agent",
    label: "Agent",
    hint: "Claude, its subagents, and the diff it is producing.",
    /*
     * For watching work happen rather than doing it by hand.
     *
     * Claude takes the left half, because in this layout the transcript is
     * the thing you are actually reading -- a swarm announces itself there
     * first, and a turn's reasoning is what you are following.
     *
     * The right column stacks the two things you check *while* it runs: the
     * subagent tree (what it is doing now) above git (what it has changed so
     * far). The tree gets the smaller share -- it is a list of short rows --
     * and git the larger, because the commit form plus a file list needs the
     * height and a diff needs room to read.
     *
     * No editor: in this layout you are reviewing, and a diff you can act on
     * beats a file you have to navigate to.
     */
    panes: ["claude", "agents", "git"],
    focus: 0,
    build: ([claude, agents, git]) =>
      branch(
        "row",
        0.52,
        leaf(claude!),
        branch("column", 0.4, leaf(agents!), leaf(git!)),
      ),
  },

  {
    id: "dev",
    label: "Dev",
    hint: "Editor, Claude, git and a shell — the full working surface.",
    /*
     * The one that replaces VS Code, and arranged like it.
     *
     * Three full-height columns: git on the left, the code in the middle,
     * Claude on the right.
     *
     * Git is a column rather than a strip along the bottom because it *is* a
     * column -- a file list, one path per row, which a quarter of the height
     * truncates for no reason while the pane sits half empty. Left, at a
     * fifth of the width, is where a source-control sidebar goes.
     *
     * The middle column is the editor over a shell, because a shell is where
     * you run what you just read; putting them in one column keeps that pair
     * together and gives the editor the width it needs for real lines of code.
     *
     * Claude runs down the right at a full-height quarter, so a turn stays
     * visible while you work rather than being something you switch to.
     */
    panes: ["git", "editor", "shell", "claude"],
    focus: 1,
    build: ([git, editor, shell, claude]) =>
      branch(
        "row",
        0.22,
        leaf(git!),
        branch(
          "row",
          0.66,
          branch("column", 0.72, leaf(editor!), leaf(shell!)),
          leaf(claude!),
        ),
      ),
  },
];

/** The preset a new workspace uses when nothing else is chosen. */
export const DEFAULT_PRESET = "lite";

export const presetById = (id: string): LayoutPreset | undefined =>
  PRESETS.find((p) => p.id === id);

/** A pane that already exists in the workspace, as the planner sees it. */
export interface OpenPane {
  id: string;
  kind: string;
}

export interface PresetPlan {
  /** Existing panes reused, in the preset's slot order. `undefined` where new. */
  keep: OpenPane[];
  /** Kinds the preset needs that nothing open could fill, in slot order. */
  create: LayoutPaneKind[];
  /** Pane ids to close and whose processes to kill. */
  kill: string[];
  /** Pinned panes the preset had no slot for. Kept, never killed. */
  extra: string[];
}

/**
 * Decide which panes to reuse, create and close when a preset is applied.
 *
 * Separated from the React callback because the stake is higher than layout:
 * a `claude` pane holds a live session and a `shell` pane holds a PTY with
 * real history, so getting reuse wrong destroys work rather than just looking
 * wrong. That is worth proving directly.
 *
 * Rules, in order:
 *   - a slot is filled by an open pane of the same kind, pinned ones first;
 *   - each open pane fills at most one slot;
 *   - a pinned pane with no slot is kept anyway, because a pin exists to
 *     prevent exactly the outcome of closing it;
 *   - everything else is closed.
 */
export function planPresetApply(
  preset: LayoutPreset,
  open: OpenPane[],
  pinned: ReadonlySet<string>,
): PresetPlan {
  const byKind = new Map<string, OpenPane[]>();
  for (const pane of open) {
    const list = byKind.get(pane.kind) ?? [];
    list.push(pane);
    byKind.set(pane.kind, list);
  }
  // Pinned first, so a pin survives even when several panes could fill a slot.
  for (const list of byKind.values()) {
    list.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  }

  const keep: OpenPane[] = [];
  const create: LayoutPaneKind[] = [];
  for (const kind of preset.panes) {
    const existing = byKind.get(kind)?.shift();
    if (existing) keep.push(existing);
    else create.push(kind);
  }

  const leftover = [...byKind.values()].flat();
  const extra = leftover.filter((p) => pinned.has(p.id)).map((p) => p.id);
  const kill = leftover.filter((p) => !pinned.has(p.id)).map((p) => p.id);

  return { keep, create, kill, extra };
}
