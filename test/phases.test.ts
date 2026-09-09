/**
 * The handoff's phases, as agents.
 *
 * Ported from the tests that covered `handoffRunner.ts`, because the
 * properties they pinned are the safety story and did not stop mattering when
 * the prompts moved into files:
 *
 *   - a phase that hangs is killed, and the kill reaches the whole tree
 *   - the drift reviewer never resumes the session that wrote the change
 *   - a reviewer cannot edit what it is reviewing
 *
 * A fake `claude` on PATH stands in for the CLI: what is under test is fove's
 * handling, not the model's judgment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, execute, review, drift } from "../src/main/phases.js";
import { makeRunDir } from "../src/main/agentRunner.js";

let bin: string;
let repo: string;
let runDir: string;
let originalPath: string | undefined;

function fakeClaude(body: string): void {
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, "argv.txt")}"\n${body}\n`);
  chmodSync(join(bin, "claude"), 0o755);
}

/** Answers with `reply`, after writing `content` to the path in the prompt. */
function answering(reply: unknown, content?: string): void {
  const write = content
    ? `OUT=$(printf '%s\\n' "$@" | grep -o '/[^ ]*\\.json' | tail -1)\n[ -n "$OUT" ] && mkdir -p "$(dirname "$OUT")" && cat > "$OUT" <<'BODY'\n${content}\nBODY`
    : "";
  fakeClaude(`${write}\ncat <<'JSON'\n${JSON.stringify(reply)}\nJSON`);
}

const argv = (): string =>
  existsSync(join(bin, "argv.txt")) ? readFileSync(join(bin, "argv.txt"), "utf8") : "";

/**
 * Just the `--allowed-tools` value.
 *
 * Asserting against the whole argv is wrong for tool questions: the prompts
 * contain the word "edit" as prose, so `not.toContain("Edit")` fails on a
 * command line that grants no Edit tool at all.
 */
const tools = (): string => {
  const lines = argv().split("\n");
  const i = lines.indexOf("--allowed-tools");
  return i >= 0 ? lines[i + 1] ?? "" : "";
};

const OK = { is_error: false, result: "done", total_cost_usd: 0.2, session_id: "s1" };
const opts = () => ({ cwd: repo, runDir, budgetUSD: 5 });

beforeEach(async () => {
  bin = mkdtempSync(join(tmpdir(), "fove-bin-"));
  repo = mkdtempSync(join(tmpdir(), "fove-repo-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  runDir = await makeRunDir(repo);
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("each phase runs its own agent", () => {
  it("plans with the planner", async () => {
    answering(OK, '{"summary":"s","steps":[{"n":1,"action":"a"}]}');
    const r = await plan("a ticket", [], opts());
    expect(argv()).toContain("fove-planner");
    expect(r.output?.summary).toBe("s");
  });

  it("executes with the executor, and gives it the ticket", async () => {
    /*
     * v0.9 sent only the step list, so the executor could not tell what the
     * change was *for* -- and a step that turns out to be wrong is far easier
     * to spot when you know the goal.
     */
    answering(OK);
    await execute("the original ticket", { summary: "g", steps: [{ n: 1, action: "a" }] }, opts());
    expect(argv()).toContain("fove-executor");
    expect(argv()).toContain("the original ticket");
  });

  it("reviews with the reviewer", async () => {
    answering(OK, '{"findings":[{"label":"a caller was missed","passed":false}]}');
    const r = await review(["a.ts"], opts());
    expect(argv()).toContain("fove-reviewer");
    expect(r.checks[0]?.label).toBe("a caller was missed");
  });

  it("judges drift with the drift agent", async () => {
    answering(OK, '{"violations":[{"intentId":"no-raw-sql","clause":"01","file":"db.py","evidence":"SELECT *"}]}');
    const r = await drift(
      [{ id: "no-raw-sql", headline: "Use the ORM", clauses: [{ name: "No raw SQL", text: "never" }] }],
      opts(),
    );
    expect(argv()).toContain("fove-drift");
    expect(r.violations[0]?.evidence).toContain("SELECT");
  });
});

describe("what each agent may do", () => {
  it("lets the executor run tests but not deploy", async () => {
    // The boundary is passed per-run rather than left to the agent file: a
    // limit an agent could edit is not a limit.
    answering(OK);
    await execute("t", { summary: "g", steps: [] }, opts());
    expect(tools()).toContain("Bash(npm test:*)");
    expect(tools()).not.toMatch(/Bash\(git push/);
    // Never bare `Bash`, which would grant every command there is.
    expect(tools().split(",")).not.toContain("Bash");
  });

  it("does not let the reviewer edit what it reviews", async () => {
    answering(OK, '{"findings":[]}');
    await review(["a.ts"], opts());
    expect(tools().split(",")).not.toContain("Edit");
  });

  it("does not let the planner edit the codebase", async () => {
    answering(OK, '{"summary":"s","steps":[]}');
    await plan("t", [], opts());
    expect(tools().split(",")).not.toContain("Edit");
  });
});

describe("isolation", () => {
  it("never resumes a session, so no agent grades its own work", async () => {
    /*
     * The property the discriminator rests on. A model handed its own
     * justifications is agreeing with itself, not reviewing -- so `--resume`
     * must appear nowhere, and `runAgent` has no way to pass one.
     */
    answering(OK, '{"violations":[]}');
    await drift([{ id: "r", headline: "h", clauses: [{ name: "n", text: "t" }] }], opts());
    expect(argv()).not.toContain("--resume");
  });
});

describe("when nothing needs doing", () => {
  it("does not run the reviewer on an empty change", async () => {
    answering(OK);
    const r = await review([], opts());
    expect(r.costUSD).toBe(0);
    expect(argv()).toBe("");
  });

  it("does not run drift when the repository has no rules", async () => {
    // With no rules there is nothing to drift from, and asking anyway invites
    // the model to invent one to have something to say.
    answering(OK);
    const r = await drift([], opts());
    expect(r.violations).toEqual([]);
    expect(argv()).toBe("");
  });
});

describe("a phase that hangs", () => {
  it("is killed, and says so rather than reporting success", async () => {
    fakeClaude("sleep 30");
    const started = Date.now();
    const r = await plan("t", [], { ...opts(), timeoutMs: 300 });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no result after/);
    // Killed near the deadline, not after the sleep: the kill reaches the
    // whole process group, or `close` never fires and the timeout only moves
    // the hang later.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("settles when stopped, rather than waiting out the timeout", async () => {
    fakeClaude("sleep 30");
    const abort = new AbortController();
    const started = Date.now();
    const p = execute("t", { summary: "g", steps: [] }, {
      ...opts(), signal: abort.signal, timeoutMs: 60_000,
    });
    setTimeout(() => abort.abort(), 150);

    await p;
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
