/**
 * The starting layouts.
 *
 * A preset that builds a malformed tree would break a workspace at the moment
 * it is created, which is the worst possible time -- so every preset is
 * checked against the same invariants the layout engine relies on: every pane
 * placed exactly once, every leaf referencing a real pane, ratios in range.
 *
 * These are cheap checks, but they are the ones that catch a typo'd index in
 * a hand-built tree, which is exactly the mistake this file's shape invites.
 */

import { describe, expect, test } from "vitest";
import { PRESETS, DEFAULT_PRESET, presetById } from "../src/shared/layouts.js";
import { paneIds, place, MIN_RATIO, type Node } from "../src/shared/layout.js";
import { planPresetApply } from "../src/shared/layouts.js";

/** Ids matched positionally to a preset's pane list, as the caller supplies. */
const idsFor = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

/** Every branch in a tree, for checking ratios. */
function branches(node: Node): Extract<Node, { kind: "branch" }>[] {
  if (node.kind === "leaf") return [];
  return [node, ...branches(node.a), ...branches(node.b)];
}

describe("every preset", () => {
  test.each(PRESETS.map((p) => [p.id, p] as const))("%s builds a usable tree", (_id, preset) => {
    const ids = idsFor(preset.panes.length);
    const tree = preset.build(ids);

    // Every pane appears exactly once: a duplicated index would render the
    // same pane twice and a missing one would strand a pane with no home.
    const placed = paneIds(tree);
    expect([...placed].sort()).toEqual([...ids].sort());
    expect(placed.length).toBe(new Set(placed).size);
  });

  test.each(PRESETS.map((p) => [p.id, p] as const))("%s has sane ratios", (_id, preset) => {
    for (const b of branches(preset.build(idsFor(preset.panes.length)))) {
      expect(b.ratio).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(b.ratio).toBeLessThanOrEqual(1 - MIN_RATIO);
    }
  });

  test.each(PRESETS.map((p) => [p.id, p] as const))("%s focuses a pane it placed", (_id, preset) => {
    expect(preset.focus).toBeGreaterThanOrEqual(0);
    expect(preset.focus).toBeLessThan(preset.panes.length);
  });

  test.each(PRESETS.map((p) => [p.id, p] as const))("%s lays out without overlap", (_id, preset) => {
    // The real proof: run the actual geometry engine over the tree and check
    // no two panes claim the same pixels. A bad ratio or a malformed branch
    // shows up here and nowhere else.
    const ids = idsFor(preset.panes.length);
    const { panes } = place(preset.build(ids), { x: 0, y: 0, w: 1440, h: 900 }, 6);
    const list = panes;
    expect(list.length).toBe(ids.length);

    for (const r of list) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const overlaps =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps).toBe(false);
      }
    }
  });

  test.each(PRESETS.map((p) => [p.id, p] as const))("%s has a label and a hint", (_id, preset) => {
    expect(preset.label.length).toBeGreaterThan(0);
    expect(preset.hint.length).toBeGreaterThan(0);
  });
});

describe("the preset list", () => {
  test("ids are unique", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("the default exists", () => {
    // A default naming a preset that was renamed away would leave new
    // workspaces with no layout at all.
    expect(presetById(DEFAULT_PRESET)).toBeDefined();
  });

  test("an unknown id resolves to nothing rather than throwing", () => {
    expect(presetById("no-such-preset")).toBeUndefined();
  });

  test("every preset places at least two panes", () => {
    // A one-pane preset is just the old behaviour wearing a name.
    for (const p of PRESETS) expect(p.panes.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Applying a preset to a workspace that is already in use.
 *
 * The stake here is not cosmetic: a `claude` pane holds a live session and a
 * `shell` pane holds a PTY with real history. Rebuilding those to satisfy a
 * layout would destroy work in order to tidy the furniture, so reuse is the
 * property worth pinning.
 */
describe("applying a preset over existing panes", () => {
  const open = (...kinds: [string, string][]) =>
    kinds.map(([id, kind]) => ({ id, kind }));

  test("reuses a pane of the same kind rather than making a new one", () => {
    const plan = planPresetApply(
      presetById("lite")!,
      open(["claude-1", "claude"], ["shell-1", "shell"]),
      new Set(),
    );
    // Same ids: the running session and the PTY both survive.
    expect(plan.keep.map((p) => p.id).sort()).toEqual(["claude-1", "shell-1"]);
    expect(plan.create).toEqual([]);
    expect(plan.kill).toEqual([]);
  });

  test("creates only the panes the preset adds", () => {
    const plan = planPresetApply(
      presetById("agent")!,
      open(["claude-1", "claude"]),
      new Set(),
    );
    expect(plan.keep.map((p) => p.id)).toEqual(["claude-1"]);
    expect(plan.create).toEqual(["agents", "git"]);
    expect(plan.kill).toEqual([]);
  });

  test("closes panes the preset has no place for", () => {
    const plan = planPresetApply(
      presetById("lite")!,
      open(["claude-1", "claude"], ["shell-1", "shell"], ["browser-1", "browser"]),
      new Set(),
    );
    expect(plan.kill).toEqual(["browser-1"]);
  });

  test("a pinned pane is never closed, even when the preset has no slot", () => {
    // A pin exists precisely to prevent this outcome.
    const plan = planPresetApply(
      presetById("lite")!,
      open(["claude-1", "claude"], ["shell-1", "shell"], ["browser-1", "browser"]),
      new Set(["browser-1"]),
    );
    expect(plan.kill).toEqual([]);
    expect(plan.extra).toEqual(["browser-1"]);
  });

  test("a pinned pane wins the slot over an unpinned one of the same kind", () => {
    const plan = planPresetApply(
      presetById("lite")!,
      open(["shell-a", "shell"], ["shell-b", "shell"], ["claude-1", "claude"]),
      new Set(["shell-b"]),
    );
    expect(plan.keep.map((p) => p.id)).toContain("shell-b");
    expect(plan.kill).toEqual(["shell-a"]);
  });

  test("duplicate kinds are consumed one per slot, not reused twice", () => {
    // `dev` asks for one shell; two open shells must not both fill it.
    const plan = planPresetApply(
      presetById("dev")!,
      open(["shell-a", "shell"], ["shell-b", "shell"]),
      new Set(),
    );
    const shells = plan.keep.filter((p) => p.kind === "shell");
    expect(shells).toHaveLength(1);
    expect(plan.kill).toEqual(["shell-b"]);
  });
});
