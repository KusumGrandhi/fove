/**
 * Running a Claude Code agent, and reading what it wrote.
 *
 * These use a fake `claude` on PATH: the behaviour under test is fove's
 * handling of an agent's result, not the model's judgment.
 *
 * The rules that matter are all about *not lying about the outcome*. An agent
 * that talked instead of writing its file has failed, and must be reported as
 * having failed -- "it produced nothing" and "it decided there was nothing to
 * do" must never render the same, which is the same rule the drift reviewer
 * follows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, makeRunDir, runsRoot } from "../src/main/agentRunner.js";

let bin: string;
let repo: string;
let originalPath: string | undefined;

/** A fake `claude` that records its argv and answers with `reply`. */
function fakeClaude(reply: unknown, opts: { writes?: [string, string] } = {}): void {
  const write = opts.writes
    ? `mkdir -p "$(dirname '${opts.writes[0]}')" && cat > '${opts.writes[0]}' <<'BODY'\n${opts.writes[1]}\nBODY`
    : "";
  writeFileSync(join(bin, "claude"), `#!/bin/sh
printf '%s\\n' "$@" > "${join(bin, "argv.txt")}"
${write}
cat <<'JSON'
${JSON.stringify(reply)}
JSON
`);
  chmodSync(join(bin, "claude"), 0o755);
}

const argv = (): string =>
  existsSync(join(bin, "argv.txt")) ? readFileSync(join(bin, "argv.txt"), "utf8") : "";

const OK = { is_error: false, result: "done", total_cost_usd: 0.2, session_id: "s1" };

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

describe("invoking the agent", () => {
  it("runs it by name, so the prompt lives in a file you can edit", async () => {
    fakeClaude(OK);
    await runAgent({ agent: "fove-planner", prompt: "do a thing", cwd: repo });
    expect(argv()).toContain("--agent");
    expect(argv()).toContain("fove-planner");
  });

  it("passes the tool allowlist as one comma-joined value", async () => {
    fakeClaude(OK);
    await runAgent({
      agent: "a", prompt: "p", cwd: repo,
      allowedTools: ["Read", "Bash(npm test:*)"],
    });
    expect(argv()).toContain("Read,Bash(npm test:*)");
  });

  it("omits the budget flag when there is no cap", async () => {
    fakeClaude(OK);
    await runAgent({ agent: "a", prompt: "p", cwd: repo, budgetUSD: 0 });
    expect(argv()).not.toContain("--max-budget-usd");
  });
});

describe("reading what the agent wrote", () => {
  it("returns the file's contents when the agent wrote it", async () => {
    const out = join(repo, "plan.json");
    fakeClaude(OK, { writes: [out, '{"summary":"s","steps":[{"n":1,"action":"a"}]}'] });

    const r = await runAgent<{ summary: string }>({
      agent: "a", prompt: "p", cwd: repo, outputPath: out,
    });

    expect(r.ok).toBe(true);
    expect(r.output?.summary).toBe("s");
    expect(r.costUSD).toBeCloseTo(0.2, 2);
  });

  it("fails when the agent talked instead of writing the file", async () => {
    /*
     * The failure mode this whole design has to get right. Returning ok with
     * no plan would render as "the agent had nothing to propose", which is a
     * different and much more reassuring claim than the truth.
     */
    fakeClaude({ ...OK, result: "Here is my plan: first, we should..." });

    const r = await runAgent({
      agent: "fove-planner", prompt: "p", cwd: repo, outputPath: join(repo, "plan.json"),
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not write");
    // The words it said are kept: they are the only clue to why.
    expect(r.text).toContain("Here is my plan");
  });

  it("fails clearly when the file is not valid JSON", async () => {
    const out = join(repo, "plan.json");
    fakeClaude(OK, { writes: [out, "I decided to write prose instead"] });

    const r = await runAgent({ agent: "a", prompt: "p", cwd: repo, outputPath: out });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });

  it("needs no output file when a phase has nothing to return", async () => {
    // The executor's result is the working tree, not a document.
    fakeClaude(OK);
    const r = await runAgent({ agent: "fove-executor", prompt: "p", cwd: repo });
    expect(r.ok).toBe(true);
  });
});

describe("failures", () => {
  it("reports a missing agent file rather than hanging", async () => {
    // The CLI exits without JSON; whatever is on stderr is the useful part.
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "no agent named x" >&2\nexit 1\n');
    chmodSync(join(bin, "claude"), 0o755);

    const r = await runAgent({ agent: "x", prompt: "p", cwd: repo });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no agent named x");
  });

  it("stops an agent that never returns, and says so", async () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "claude"), 0o755);

    const started = Date.now();
    const r = await runAgent({ agent: "a", prompt: "p", cwd: repo, timeoutMs: 300 });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no result after/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("surfaces an error the CLI itself reported", async () => {
    fakeClaude({ is_error: true, result: "budget exceeded", total_cost_usd: 5 });
    const r = await runAgent({ agent: "a", prompt: "p", cwd: repo });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("budget exceeded");
  });
});

describe("where artifacts live", () => {
  it("keeps them in the repository, under .fove", async () => {
    /*
     * Not `~/.fove`, and not `.claude`. Both were tried: an agent cannot write
     * outside its working directory, and Claude Code refuses writes into
     * `.claude/` because it protects its own configuration.
     */
    // Compared against the resolved repo path: `makeRunDir` resolves symlinks
    // on purpose, because a macOS temp dir is `/var/...` but resolves to
    // `/private/var/...` and the two must not disagree.
    const dir = await makeRunDir(repo);
    expect(dir.startsWith(runsRoot(realpathSync(repo)))).toBe(true);
    expect(dir).not.toContain("/.claude/");
  });

  it("gives each run its own directory", async () => {
    const a = await makeRunDir(repo);
    const b = await makeRunDir(repo);
    expect(a).not.toBe(b);
  });
});
