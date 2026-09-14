import { describe, expect, test } from "vitest";
import { breadcrumb, disambiguate, relativeTo } from "../src/shared/editor-tabs.js";

describe("disambiguate", () => {
  test("a unique basename is left alone", () => {
    const labels = disambiguate(["/r/src/App.tsx", "/r/src/main.tsx"]);
    expect(labels.get("/r/src/App.tsx")).toBe("App.tsx");
    expect(labels.get("/r/src/main.tsx")).toBe("main.tsx");
  });

  test("a collision grows one directory", () => {
    const labels = disambiguate(["/r/a/index.ts", "/r/b/index.ts"]);
    expect(labels.get("/r/a/index.ts")).toBe("a/index.ts");
    expect(labels.get("/r/b/index.ts")).toBe("b/index.ts");
  });

  test("a collision that survives one directory grows further", () => {
    const labels = disambiguate(["/r/x/ui/index.ts", "/r/y/ui/index.ts"]);
    expect(labels.get("/r/x/ui/index.ts")).toBe("x/ui/index.ts");
    expect(labels.get("/r/y/ui/index.ts")).toBe("y/ui/index.ts");
  });

  test("colliding and non-colliding names coexist", () => {
    const labels = disambiguate(["/r/a/index.ts", "/r/b/index.ts", "/r/App.tsx"]);
    expect(labels.get("/r/App.tsx")).toBe("App.tsx");
    expect(labels.get("/r/a/index.ts")).toBe("a/index.ts");
  });

  test("identical paths do not loop", () => {
    const labels = disambiguate(["/r/a.ts", "/r/a.ts"]);
    expect(labels.get("/r/a.ts")).toBe("a.ts");
  });
});

describe("breadcrumb", () => {
  test("is relative to the root, with the file last", () => {
    const crumbs = breadcrumb("/r", "/r/src/panes/Editor.tsx");
    expect(crumbs.map((c) => c.name)).toEqual(["src", "panes", "Editor.tsx"]);
    expect(crumbs.at(-1)).toMatchObject({ leaf: true, path: "/r/src/panes/Editor.tsx" });
    expect(crumbs[0]).toMatchObject({ leaf: false, path: "/r/src" });
  });

  test("a file outside the root keeps its whole path", () => {
    const crumbs = breadcrumb("/r", "/other/thing.ts");
    expect(crumbs.map((c) => c.name)).toEqual(["other", "thing.ts"]);
  });

  test("a trailing slash on the root does not shift the split", () => {
    expect(breadcrumb("/r/", "/r/a/b.ts").map((c) => c.name)).toEqual(["a", "b.ts"]);
  });
});

describe("relativeTo", () => {
  test("strips the root", () => {
    expect(relativeTo("/r", "/r/src/git.ts")).toBe("src/git.ts");
  });

  test("a file outside the root has no relative form", () => {
    expect(relativeTo("/r", "/elsewhere/git.ts")).toBeNull();
    expect(relativeTo("/r", "/r")).toBeNull();
  });

  test("a sibling directory with a shared prefix is not inside the root", () => {
    expect(relativeTo("/r/app", "/r/appendix/x.ts")).toBeNull();
  });
});
