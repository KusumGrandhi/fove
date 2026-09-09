/**
 * An editor pane's open file must reach the persisted layout.
 *
 * The layout is what a popped-out window reads to rebuild a pane, so if it
 * does not follow the editor, popping out reopens a stale file -- or none, and
 * the window shows "select a file from the tree" instead of what you were
 * looking at. That was the reported bug.
 *
 * The gap was that `openPath` was only ever written by `openInPane`, the
 * palette/search route. Opening a file from the editor's *own* tree changed
 * the pane's internal state and nothing else.
 *
 * This tests the reducer that closes the gap, not React: the rule is which
 * pane gets updated and when a write is skipped.
 */

import { describe, expect, it } from "vitest";
import { noteEditorPath } from "../src/shared/tabs.js";

interface Pane { id: string; kind: string; openPath?: string; openNonce?: number }
interface Tab { id: string; panes: Record<string, Pane> }

const tabs = (): Tab[] => [
  { id: "t1", panes: { e1: { id: "e1", kind: "editor", openPath: "/a.ts" } } },
  { id: "t2", panes: { e2: { id: "e2", kind: "editor" }, s1: { id: "s1", kind: "shell" } } },
];

describe("recording the editor's open file", () => {
  it("writes the path the editor reports", () => {
    const out = noteEditorPath(tabs(), "e1", "/b.ts");
    expect(out[0]!.panes.e1!.openPath).toBe("/b.ts");
  });

  it("updates a pane in a background tab, not only the active one", () => {
    // A background tab's editor still reports; writing into the wrong tab
    // would corrupt both.
    const out = noteEditorPath(tabs(), "e2", "/c.ts");
    expect(out[1]!.panes.e2!.openPath).toBe("/c.ts");
    expect(out[0]!.panes.e1!.openPath).toBe("/a.ts");
  });

  it("clears the path when the editor closes its last file", () => {
    const out = noteEditorPath(tabs(), "e1", null);
    expect(out[0]!.panes.e1!.openPath).toBeUndefined();
  });

  it("leaves non-editor panes alone", () => {
    const out = noteEditorPath(tabs(), "s1", "/d.ts");
    expect(out[1]!.panes.s1!.openPath).toBeUndefined();
  });

  it("is a no-op when the path is unchanged, so it cannot loop", () => {
    /*
     * The pane reports on mount with the file it was told to open, which is
     * already in the layout. Returning a new object there would persist, which
     * re-renders, which reports again.
     */
    const before = tabs();
    const after = noteEditorPath(before, "e1", "/a.ts");
    expect(after[0]).toBe(before[0]); // same reference: nothing was written
  });

  it("never touches openNonce, which would re-trigger an open", () => {
    const before: Tab[] = [
      { id: "t1", panes: { e1: { id: "e1", kind: "editor", openPath: "/a.ts", openNonce: 42 } } },
    ];
    const after = noteEditorPath(before, "e1", "/b.ts");
    expect(after[0]!.panes.e1!.openNonce).toBe(42);
  });
});
