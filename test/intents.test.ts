/**
 * Intents: the format, and where they are allowed to live.
 *
 * Two properties carry the weight here. The format has to survive being
 * hand-edited badly, because a human owns the file. And the store must never
 * write into the working tree -- `core` is a production repository shared with
 * a team, and a tool that needs a PR to configure itself does not get used.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toMarkdown, fromMarkdown, stateOf, sortClauses, coverage, seedCandidates,
  type Intent, type Clause,
} from "../src/shared/intents.js";
import { IntentStore, repoIdentity } from "../src/main/intentStore.js";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

const clause = (num: string, name: string, over: Partial<Clause> = {}): Clause => ({
  num, name, text: `${name} always holds.`, state: "unverifiable", ...over,
});

describe("the format", () => {
  it("round-trips an intent", () => {
    const intent: Intent = {
      id: "sanctions",
      headline: "A sanctions decision is always fresh.",
      scope: "flask/core/**",
      clauses: [
        clause("01", "Never served from cache", { mechanism: "pytest -k not_cached" }),
        clause("02", "Every call is logged"),
      ],
    };

    const back = fromMarkdown("sanctions", toMarkdown(intent));
    expect(back.headline).toBe(intent.headline);
    expect(back.scope).toBe("flask/core/**");
    expect(back.clauses).toHaveLength(2);
    expect(back.clauses[0]!.mechanism).toBe("pytest -k not_cached");
    expect(back.clauses[1]!.mechanism).toBeUndefined();
  });

  it("keeps a prose-only clause, because a mechanism is optional", () => {
    /*
     * The commitment that shapes the format. Requiring a check before a rule
     * may exist means the rules that matter most never get written -- "error
     * messages should say what to do next" will never have a mechanism.
     */
    const md = "# Errors are actionable\n\n## 01. Say what to do next\n\nNot just what failed.\n";
    const back = fromMarkdown("errors", md);
    expect(back.clauses).toHaveLength(1);
    expect(back.clauses[0]!.mechanism).toBeUndefined();
    expect(back.clauses[0]!.text).toBe("Not just what failed.");
  });

  it("survives a badly hand-edited file", () => {
    // A human owns this file. One malformed clause should cost that clause.
    const md = [
      "# Headline",
      "",
      "## not-a-number. Ignored",
      "",
      "## 2. Real clause",
      "",
      "This one parses.",
    ].join("\n");
    const back = fromMarkdown("x", md);
    expect(back.clauses.map((c) => c.name)).toEqual(["Real clause"]);
    // Numbers are padded so they sort and cite consistently.
    expect(back.clauses[0]!.num).toBe("02");
  });

  it("returns an empty set rather than throwing on nonsense", () => {
    const back = fromMarkdown("x", "just some prose with no structure at all");
    expect(back.clauses).toEqual([]);
    expect(back.headline).toBe("x");
  });

  it("preserves multi-line clause prose", () => {
    const md = "# H\n\n## 01. Name\n\nFirst line.\n\nSecond paragraph.\n";
    expect(fromMarkdown("x", md).clauses[0]!.text).toContain("Second paragraph.");
  });
});

describe("clause state", () => {
  it("is proven only when a mechanism ran and passed", () => {
    const c = clause("01", "x", { mechanism: "true" });
    expect(stateOf(c, { passed: true, ranAt: Date.now() })).toBe("proven");
  });

  it("is drifted when a mechanism ran and failed", () => {
    const c = clause("01", "x", { mechanism: "false" });
    expect(stateOf(c, { passed: false, ranAt: Date.now() })).toBe("drifted");
  });

  it("is NOT proven when a mechanism exists but has not run", () => {
    /*
     * The conservative rule that makes `proven` mean something. "It passed
     * yesterday" and "it passes now" are different claims, and only the second
     * is worth a green state.
     */
    const c = clause("01", "x", { mechanism: "pytest -k thing" });
    expect(stateOf(c)).toBe("unverifiable");
  });

  it("is drifted when an agent flagged it, even with no mechanism", () => {
    expect(stateOf(clause("01", "x"), undefined, true)).toBe("drifted");
  });
});

describe("ordering and coverage", () => {
  it("puts drifted clauses first and proven last", () => {
    const sorted = sortClauses([
      clause("01", "a", { state: "proven" }),
      clause("02", "b", { state: "unverifiable" }),
      clause("03", "c", { state: "drifted" }),
      clause("04", "d", { state: "contested" }),
    ]);
    expect(sorted.map((c) => c.state)).toEqual(
      ["drifted", "contested", "unverifiable", "proven"],
    );
  });

  it("counts how many clauses are checkable at all", () => {
    // The number that matters: prose is the norm, so this says how much of the
    // set is deterministic rather than resting on an agent's judgment.
    const intents: Intent[] = [{
      id: "x", headline: "h",
      clauses: [clause("01", "a", { mechanism: "true" }), clause("02", "b")],
    }];
    expect(coverage(intents)).toEqual({ total: 2, withMechanism: 1 });
  });
});

describe("seeding from a repository's own conventions", () => {
  it("finds prescriptive rules and ignores description", () => {
    const md = [
      "# Conventions",
      "This project uses Flask and Postgres.",
      "- NEVER commit secrets to the repository",
      "- Use specific exceptions, never bare `except:`",
      "The build runs on CI.",
    ].join("\n");

    const out = seedCandidates(md);
    const texts = out.map((c) => c.text);
    expect(texts.some((t) => t.includes("NEVER commit secrets"))).toBe(true);
    expect(texts.some((t) => t.includes("never bare"))).toBe(true);
    // Statements of fact are not rules.
    expect(texts.some((t) => t.includes("uses Flask"))).toBe(false);
    expect(texts.some((t) => t.includes("runs on CI"))).toBe(false);
  });

  it("does not repeat a rule stated twice", () => {
    const md = "- NEVER commit secrets\n- never commit secrets\n";
    expect(seedCandidates(md)).toHaveLength(1);
  });

  it("skips headings and fences", () => {
    const md = "## You must always read this\n```\nnever run this\n```\n";
    expect(seedCandidates(md).every((c) => !c.text.startsWith("#"))).toBe(true);
  });
});

describe("the store", () => {
  let repo: string;
  let home: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "fove-intent-repo-"));
    home = await mkdtemp(join(tmpdir(), "fove-intent-home-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "T"]);
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("identifies a repository without a remote by its root commit", async () => {
    const id = await repoIdentity(repo);
    expect(id).toBeTruthy();
    // No remote, so no readable name is available -- just "repo" and the hash
    // of the root commit. The directory name is deliberately *not* used: it
    // differs per worktree, which would split the store.
    expect(id).toMatch(/^repo-[0-9a-f]{10}$/);
  });

  it("gives a worktree the same identity as its parent", async () => {
    // The reason identity is not a path: intents written in one worktree must
    // be visible from all of them.
    const wt = join(tmpdir(), `fove-wt-${Date.now()}`);
    try {
      await git(repo, ["worktree", "add", "-q", wt, "-b", "side"]);
      expect(await repoIdentity(wt)).toBe(await repoIdentity(repo));
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("does not confuse two unrelated repositories with no remote", async () => {
    /*
     * The bug this replaced. Identity used the root commit sha, and two repos
     * created from identical content in the same second produce the *same*
     * root commit -- so unrelated projects shared an intent store and mixed
     * each other's rules. Reproduced with real git before the fix.
     */
    const other = await mkdtemp(join(tmpdir(), "fove-intent-repo-"));
    try {
      await git(other, ["init", "-q", "-b", "main"]);
      await git(other, ["config", "user.email", "t@t"]);
      await git(other, ["config", "user.name", "T"]);
      await writeFile(join(other, "a.txt"), "one\n");
      await git(other, ["add", "-A"]);
      await git(other, ["commit", "-qm", "first"]);

      expect(await repoIdentity(other)).not.toBe(await repoIdentity(repo));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("returns nothing for a directory that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "fove-plain-"));
    try {
      expect(await repoIdentity(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("NEVER writes into the working tree", async () => {
    /*
     * The hard constraint. A `.fove/` directory inside `core` would mean a PR
     * putting one developer's tooling into everyone's checkout -- and a tool
     * that dirties a production tree is one you have to remember to clean up
     * before every commit.
     */
    const store = new IntentStore();
    await store.save(repo, {
      id: "test", headline: "H", clauses: [clause("01", "a")],
    });

    const entries = await readdir(repo);
    expect(entries).not.toContain(".fove");
    // The decisive check: git must see nothing new.
    const { stdout } = await git(repo, ["status", "--porcelain"]);
    expect(stdout.trim()).toBe("");
  });

  it("reads back what it saved", async () => {
    const store = new IntentStore();
    const intent: Intent = {
      id: "sanctions", headline: "Fresh decisions",
      clauses: [clause("01", "Never cached", { mechanism: "true" })],
    };
    const saved = await store.save(repo, intent);
    expect(saved.ok).toBe(true);
    // Outside the tree, under the fove home.
    expect(saved.path).toContain(".fove/intents/");

    const loaded = await store.load(repo);
    expect(loaded.intents).toHaveLength(1);
    expect(loaded.intents[0]!.clauses[0]!.mechanism).toBe("true");
  });

  it("has no intents for a fresh repository, and says so without failing", async () => {
    const loaded = await new IntentStore().load(repo);
    expect(loaded.intents).toEqual([]);
    expect(loaded.identity).toBeTruthy();
  });

  it("offers rules from AGENTS.md without adopting them", async () => {
    await writeFile(join(repo, "AGENTS.md"), "- NEVER commit secrets to the repo\n");
    const loaded = await new IntentStore().load(repo);
    expect(loaded.candidates.some((c) => c.text.includes("NEVER commit secrets"))).toBe(true);
    expect(loaded.candidates[0]!.from).toBe("AGENTS.md");
    // Offered, not adopted: nothing was written.
    expect(loaded.intents).toEqual([]);
  });

  it("stops offering a candidate once it has been adopted", async () => {
    const store = new IntentStore();
    await writeFile(join(repo, "AGENTS.md"), "- NEVER commit secrets to the repo\n");
    await store.save(repo, {
      id: "secrets", headline: "Secrets",
      clauses: [clause("01", "No secrets", { text: "NEVER commit secrets to the repo" })],
    });
    const loaded = await store.load(repo);
    expect(loaded.candidates.some((c) => c.text.includes("NEVER commit secrets"))).toBe(false);
  });

  it("runs a mechanism and reports the result", async () => {
    const store = new IntentStore();
    const pass = await store.runMechanism(repo, "exit 0");
    expect(pass.passed).toBe(true);
    const fail = await store.runMechanism(repo, "echo nope >&2; exit 1");
    expect(fail.passed).toBe(false);
    expect(fail.output).toContain("nope");
  });

  it("runs a mechanism from the workspace root", async () => {
    // A mechanism is usually a `rg` over the repo, so the cwd matters.
    const out = await new IntentStore().runMechanism(repo, "ls a.txt");
    expect(out.passed).toBe(true);
    expect(out.output).toContain("a.txt");
  });

  it("deletes an intent", async () => {
    const store = new IntentStore();
    await store.save(repo, { id: "gone", headline: "H", clauses: [clause("01", "a")] });
    expect((await store.remove(repo, "gone")).ok).toBe(true);
    expect((await store.load(repo)).intents).toEqual([]);
  });
});
