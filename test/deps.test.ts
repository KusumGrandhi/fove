import { describe, expect, test } from "vitest";
import {
  DEPS, report, summary, isUsable, installCommand, type DepStatus,
} from "../src/shared/deps.js";

/** Every dep found, so a test can then take one away. */
const allFound = (): DepStatus[] =>
  DEPS.map((d) => ({ bin: d.bin, path: `/usr/local/bin/${d.bin}`, version: "1.0" }));

const without = (...bins: string[]): DepStatus[] =>
  allFound().filter((s) => !bins.includes(s.bin));

describe("the dependency spec", () => {
  test("names claude and git as required", () => {
    const required = DEPS.filter((d) => d.severity === "required").map((d) => d.bin);
    expect(required).toEqual(["claude", "git"]);
  });

  test("every dep says what it is for", () => {
    for (const d of DEPS) {
      expect(d.needs.length).toBeGreaterThan(10);
      expect(d.label).toBeTruthy();
    }
  });

  test("every dep offers a way to get it", () => {
    for (const d of DEPS) expect(d.brew ?? d.url).toBeTruthy();
  });
});

describe("report", () => {
  test("marks what was found", () => {
    const r = report(without("tmux"));
    expect(r.find((x) => x.dep.bin === "tmux")!.found).toBe(false);
    expect(r.find((x) => x.dep.bin === "git")!.found).toBe(true);
  });

  test("a dep nothing reported on is missing, not absent from the list", () => {
    // The checker may not have run yet; the row still exists.
    const r = report([]);
    expect(r).toHaveLength(DEPS.length);
    expect(r.every((x) => !x.found)).toBe(true);
  });

  test("keeps the spec's order regardless of the input order", () => {
    const shuffled = [...allFound()].reverse();
    expect(report(shuffled).map((r) => r.dep.bin)).toEqual(DEPS.map((d) => d.bin));
  });
});

describe("summary", () => {
  test("says nothing when the machine is ready", () => {
    expect(summary(report(allFound()))).toBeNull();
  });

  test("leads with a required tool, ignoring lesser ones", () => {
    const s = summary(report(without("claude", "tmux", "code")))!;
    expect(s).toContain("Claude Code");
    expect(s).toContain("cannot work");
    // The feature-level miss must not bury the fatal one.
    expect(s).not.toContain("ripgrep");
  });

  test("uses singular and plural correctly", () => {
    expect(summary(report(without("git")))!).toContain("is missing");
    expect(summary(report(without("claude", "git")))!).toContain("are missing");
  });

  test("reports feature losses when nothing required is missing", () => {
    const s = summary(report(without("tmux", "rg")))!;
    expect(s).toContain("tmux");
    expect(s).toContain("ripgrep");
    expect(s).toContain("unavailable");
  });

  test("mentions an optional tool only when it is the only thing missing", () => {
    expect(summary(report(without("code")))!).toContain("optional");
  });
});

describe("isUsable", () => {
  test("a full machine is usable", () => {
    expect(isUsable(report(allFound()))).toBe(true);
  });

  test("missing tmux or ripgrep does not make the app unusable", () => {
    expect(isUsable(report(without("tmux", "rg", "code")))).toBe(true);
  });

  test("missing claude does", () => {
    expect(isUsable(report(without("claude")))).toBe(false);
  });
});

describe("installCommand", () => {
  test("gives a brew line where there is a formula", () => {
    const tmux = DEPS.find((d) => d.bin === "tmux")!;
    expect(installCommand(tmux)).toBe("brew install tmux");
  });

  test("declines for tools brew does not install", () => {
    const claude = DEPS.find((d) => d.bin === "claude")!;
    expect(installCommand(claude)).toBeNull();
  });
});

/*
 * The shapes the menu's sheet is assembled from.
 *
 * The dialog decides its buttons from these three answers, and the case that
 * had never been exercised is the one that matters most: a machine missing
 * something required, on a fresh install.
 */
describe("what the setup sheet renders", () => {
  test("a missing required tool is fatal, offers no brew button, and names a URL", () => {
    const r = report(without("claude"));
    const claude = r.find((x) => x.dep.bin === "claude")!;

    expect(isUsable(r)).toBe(false);
    expect(summary(r)).toContain("cannot work");
    // Claude Code is not a formula, so the sheet must not offer to install it.
    expect(installCommand(claude.dep)).toBeNull();
    expect(claude.dep.url).toBeTruthy();
  });

  test("missing brew-installable tools are collected for one install button", () => {
    const r = report(without("tmux", "rg"));
    const installable = r.filter((x) => !x.found && installCommand(x.dep));
    expect(installable.map((x) => x.dep.bin)).toEqual(["tmux", "rg"]);
    expect(installable.map((x) => installCommand(x.dep))).toEqual([
      "brew install tmux",
      "brew install ripgrep",
    ]);
  });

  test("a mixed machine keeps the fatal verdict while still listing the rest", () => {
    const r = report(without("claude", "tmux"));
    expect(isUsable(r)).toBe(false);
    // Every row still renders; only the summary prioritises.
    expect(r).toHaveLength(DEPS.length);
    expect(r.filter((x) => !x.found)).toHaveLength(2);
  });
});
