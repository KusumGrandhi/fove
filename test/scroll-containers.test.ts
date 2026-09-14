/**
 * Scroll containers must actually be able to scroll.
 *
 * This guards a bug class rather than a bug. In a flex column, a child with
 * `overflow: auto` still refuses to scroll unless it also has `min-height: 0`
 * -- flex items default to `min-height: auto`, which means "at least as tall
 * as my content", so the child grows to fit and there is nothing to scroll.
 * The content past the container's edge is then clipped by whichever ancestor
 * has `overflow: hidden`, with no scrollbar to say it exists.
 *
 * Four panes shipped with exactly that shape. It is invisible in review and
 * only shows up as "I have no idea what is below the fold", so it is checked
 * mechanically here: any style declaring a scroll must also declare the
 * min-size that lets it happen.
 *
 * A CDP sweep of the running app is what proved the fixes; this stops the
 * pattern coming back without one.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UI_DIRS = ["src/renderer/panes", "src/renderer/ui"];

function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const dir of UI_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      out.push({ path: join(dir, name), text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return out;
}

/**
 * Style-object literals, as `name: { ... }` with no nested braces.
 *
 * Comments are blanked first (keeping newlines so reported line numbers stay
 * right). A `//` explaining a rule otherwise swallows the rest of the block
 * on the single line this regex sees, and a `{` inside prose would end it
 * early -- which is how the first run of this test "found" no toolbar.
 */
function styleBlocks(text: string): { name: string; body: string; line: number }[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    // `${...}` inside a template literal carries braces of its own, which
    // would end a style block early: `1px solid ${C.line}` is extremely
    // common in these files.
    .replace(/\$\{[^}]*\}/g, (m) => " ".repeat(m.length));
  const out: { name: string; body: string; line: number }[] = [];
  const re = /(\w+):\s*\{([^{}]*)\}/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    out.push({
      name: m[1]!,
      body: m[2]!.replace(/\s+/g, " "),
      line: stripped.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const scrollsVertically = (b: string) => /overflow(Y)?:\s*"(auto|scroll)"/.test(b);
const isFlexItem = (b: string) => /flex:\s*1/.test(b);
const hasMinHeight = (b: string) => /minHeight:\s*0/.test(b);

describe("flex children that scroll", () => {
  it("declare minHeight: 0, or they silently clip instead", () => {
    const broken: string[] = [];
    for (const { path, text } of sourceFiles()) {
      for (const { name, body, line } of styleBlocks(text)) {
        if (!scrollsVertically(body) || !isFlexItem(body)) continue;
        if (hasMinHeight(body)) continue;
        broken.push(`${path}:${line} — ${name}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("horizontal strips of controls", () => {
  it("scroll rather than clipping, since the app root hides overflow", () => {
    /*
     * The toolbar measured 2007px of buttons in a 1440px window: everything
     * past "Config" was unreachable with nothing on screen to say so. The app
     * root is `overflow: hidden`, so an over-wide row is cut off by the
     * window rather than scrolled to.
     */
    const app = readFileSync("src/renderer/App.tsx", "utf8");
    for (const strip of ["toolbar", "tabs"]) {
      const block = styleBlocks(app).find((b) => b.name === strip);
      expect(block, `${strip} style not found`).toBeDefined();
      expect(block!.body, `${strip} must scroll horizontally`)
        .toMatch(/overflowX:\s*"auto"/);
      expect(block!.body, `${strip} needs minWidth: 0 to shrink`)
        .toMatch(/minWidth:\s*0/);
    }
  });
});

describe("diff rows", () => {
  it("may exceed the container width, so long lines scroll instead of clipping", () => {
    /*
     * `whiteSpace: "pre"` inside a flex row is not enough: flex children
     * shrink to the container, so a long source line is squeezed and clipped
     * even though the scroll parent would have shown it.
     *
     * Only GitActions renders diff rows by hand now. The git pane's own diff
     * moved into the editor, where Monaco owns the scrolling -- so this checks
     * the panes that still hand-roll one rather than a fixed list, and stops
     * quietly passing if another pane grows its own.
     */
    const withDiffRows = sourceFiles()
      .map(({ path, text }) => ({ path, block: styleBlocks(text).find((b) => b.name === "diffLine") }))
      .filter((f) => f.block);
    expect(withDiffRows.length, "no pane renders diff rows any more").toBeGreaterThan(0);
    for (const { path, block } of withDiffRows) {
      expect(block!.body, `${path} diffLine must keep its intrinsic width`)
        .toMatch(/minWidth:\s*"min-content"/);
    }
  });
});
