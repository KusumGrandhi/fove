/**
 * Drift: a second agent judging whether a diff breaks a written rule.
 *
 * The distinction this rests on is the one that makes it worth running. A
 * model asked "did you follow the rules?" is grading its own homework, and
 * that is where models are weakest. A model shown a diff it did not write,
 * plus a list of rules, is doing ordinary review work -- reading code for
 * violations.
 *
 * So the property tested hardest here is not the verdict, it is the
 * *isolation*: the reviewer must never resume the writer's session, because
 * that would hand it every justification the writer already told itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffRunner } from "../src/main/handoffRunner.js";

let bin: string;
let repo: string;
let originalPath: string | undefined;

/** A fake `claude` that records its argv, then answers with `reply`. */
function fakeClaude(reply: unknown): void {
  const p = join(bin, "claude");
  writeFileSync(p, `#!/bin/sh
printf '%s\\n' "$@" > "${join(bin, "argv.txt")}"
cat <<'JSON'
${JSON.stringify(reply)}
JSON
`);
  chmodSync(p, 0o755);
}

const argv = (): string =>
  existsSync(join(bin, "argv.txt")) ? readFileSync(join(bin, "argv.txt"), "utf8") : "";

const intents = [{
  id: "no-raw-sql",
  headline: "Queries go through the ORM",
  clauses: [{ num: "01", name: "No raw SQL", text: "Never execute raw SQL strings." }],
}];

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "fove-bin-"));
  repo = mkdtempSync(join(tmpdir(), "fove-repo-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("isolation from the writer", () => {
  it("never resumes the session that wrote the change", async () => {
    /*
     * The property the whole idea depends on. Resuming would make this a
     * model reviewing its own reasoning, which is the thing being avoided.
     */
    fakeClaude({ is_error: false, structured_output: { violations: [] } });

    await new HandoffRunner().drift("diff --git a/x b/x", intents, {
      cwd: repo, budgetUSD: 5, sessionId: "the-writers-session",
    });

    expect(argv()).not.toContain("the-writers-session");
    expect(argv()).not.toContain("--resume");
  });

  it("reviews under a permission mode that cannot edit", async () => {
    fakeClaude({ is_error: false, structured_output: { violations: [] } });
    await new HandoffRunner().drift("a diff", intents, { cwd: repo, budgetUSD: 5 });
    expect(argv()).toContain("plan");
  });
});

describe("the verdict", () => {
  it("returns the violations it was given, with their evidence", async () => {
    fakeClaude({
      is_error: false,
      structured_output: {
        violations: [{
          intentId: "no-raw-sql", clause: "01", file: "db.py",
          evidence: 'cursor.execute("SELECT * FROM users")', confident: true,
        }],
      },
      total_cost_usd: 0.3,
    });

    const r = await new HandoffRunner().drift("a diff", intents, { cwd: repo, budgetUSD: 5 });

    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.file).toBe("db.py");
    expect(r.violations[0]!.evidence).toContain("SELECT");
    expect(r.costUSD).toBeCloseTo(0.3, 2);
  });

  it("treats an empty list as the normal answer, not a failure", async () => {
    // Most changes break no rules. If that read as an error the feature would
    // cry wolf on every clean diff.
    fakeClaude({ is_error: false, structured_output: { violations: [] } });
    const r = await new HandoffRunner().drift("a diff", intents, { cwd: repo, budgetUSD: 5 });
    expect(r.violations).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("reports an error rather than inventing a clean verdict", async () => {
    /*
     * Failing silently would be the worst outcome: "no violations" and "we
     * could not check" must never look the same.
     */
    fakeClaude({ is_error: true });
    const r = await new HandoffRunner().drift("a diff", intents, { cwd: repo, budgetUSD: 5 });
    expect(r.violations).toEqual([]);
    expect(r.error).toBeDefined();
  });
});

describe("when there is nothing to judge", () => {
  it("does not spend anything on an empty diff", async () => {
    fakeClaude({ is_error: false, structured_output: { violations: [] } });
    const r = await new HandoffRunner().drift("   ", intents, { cwd: repo, budgetUSD: 5 });
    expect(r.costUSD).toBe(0);
    expect(argv()).toBe("");        // never spawned
  });

  it("does not run when the repository has no intents", async () => {
    // With no rules there is nothing to drift from, and asking anyway would
    // invite the model to invent a rule to have something to say.
    fakeClaude({ is_error: false, structured_output: { violations: [] } });
    const r = await new HandoffRunner().drift("a real diff", [], { cwd: repo, budgetUSD: 5 });
    expect(r.violations).toEqual([]);
    expect(argv()).toBe("");
  });
});
