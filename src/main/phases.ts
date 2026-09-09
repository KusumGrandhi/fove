/**
 * The handoff's phases, each one an agent.
 *
 * What used to be three prompt constants in `handoffRunner.ts` is now three
 * markdown files and this: the small amount of code that says which agent runs
 * when, what it is allowed to touch, and where it writes its answer.
 *
 * The prompts here are deliberately thin -- a *task*, not instructions. How to
 * plan, how to verify, what to refuse: all of that lives in the agent file,
 * where you can read and change it. If a phase behaves badly the fix is to
 * edit a file, not to rebuild the app.
 */

import { join } from "node:path";
import type { Plan, CheckResult } from "../shared/handoff.js";
import { runAgent, type AgentResult } from "./agentRunner.js";
import { PLANNER, EXECUTOR, REVIEWER, DRIFT } from "./agentFiles.js";

export interface PhaseOptions {
  cwd: string;
  /** Directory for this handoff's artifacts. See `makeRunDir`. */
  runDir: string;
  budgetUSD: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

/** The rules a repository has asked to keep true, as the agents see them. */
export interface IntentBrief {
  id: string;
  headline: string;
  clauses: { num?: string; name: string; text: string }[];
}

/** Rules as a block of prose, for a prompt. Empty when there are none. */
function rulesBlock(intents: IntentBrief[]): string {
  if (intents.length === 0) return "";
  return [
    "",
    "This codebase has rules that must stay true:",
    ...intents.flatMap((i) => [
      `- ${i.headline}`,
      ...i.clauses.map((c) => `  - ${c.name}: ${c.text}`),
    ]),
    "",
    "Say in `risks` if the task cannot be done without breaking one, and name it.",
  ].join("\n");
}

/**
 * Produce a plan, without touching the codebase.
 *
 * Two things restrain it, and neither is a path permission. `--permission-mode
 * plan` cannot be used because it blocks `Write` outright, and
 * `--allowed-tools "Write(<path>)"` grants nothing at all -- both measured
 * against the installed CLI rather than assumed.
 *
 * What is left is the agent file, which says the plan file is the only file it
 * may write, and the snapshot fove takes before planning, which says whether
 * that held. The instruction is what usually works; the check is what makes it
 * safe to rely on.
 */
export async function plan(
  ticket: string,
  intents: IntentBrief[],
  opts: PhaseOptions,
): Promise<AgentResult<Plan>> {
  const outputPath = join(opts.runDir, "plan.json");

  return runAgent<Plan>({
    agent: PLANNER,
    cwd: opts.cwd,
    prompt: [
      `Plan this task:`,
      "",
      ticket,
      rulesBlock(intents),
      "",
      `Write your plan to ${outputPath}`,
    ].join("\n"),
    outputPath,
    allowedTools: ["Read", "Grep", "Glob", "Write"],
    permissionMode: "acceptEdits",
    budgetUSD: opts.budgetUSD,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });
}

/**
 * Carry out an approved plan, and verify it runs.
 *
 * The ticket goes with the plan. v0.9 sent only the step list, which meant the
 * executor could not tell what the change was *for* -- and a step that turns
 * out to be wrong is much easier to spot when you know the goal.
 *
 * `Bash` is scoped to commands that check work rather than change the world:
 * it may run the tests and read git, and it may not push, deploy or install.
 * The list is here rather than in the agent file because it is a safety
 * boundary, and a boundary that an agent can edit is not one.
 */
export async function execute(
  ticket: string,
  p: Plan,
  opts: PhaseOptions,
): Promise<AgentResult> {
  return runAgent({
    agent: EXECUTOR,
    cwd: opts.cwd,
    prompt: [
      "Carry out this approved plan.",
      "",
      `The task was: ${ticket}`,
      "",
      `Goal: ${p.summary}`,
      ...p.steps.map((s) => `${s.n}. ${s.action}${s.files?.length ? `  [${s.files.join(", ")}]` : ""}`),
      "",
      "When you are done, run whatever verifies it and say what happened.",
    ].join("\n"),
    allowedTools: [
      "Read", "Edit", "Write", "Grep", "Glob",
      // Verification, not deployment.
      "Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npx vitest:*)",
      "Bash(pytest:*)", "Bash(python:*)", "Bash(python3:*)",
      "Bash(npm run lint:*)", "Bash(npm run typecheck:*)", "Bash(npx tsc:*)",
      "Bash(go test:*)", "Bash(cargo test:*)", "Bash(make test:*)",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(ls:*)", "Bash(cat:*)",
    ],
    permissionMode: "acceptEdits",
    budgetUSD: opts.budgetUSD,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });
}

/** One rule the change was judged to break. */
export interface DriftViolation {
  intentId: string;
  /** Clause number within that intent, e.g. "01". */
  clause: string;
  file: string;
  /** The line or construct that breaks it, quoted. */
  evidence: string;
  /** False when the reviewer was inferring rather than reading a clear breach. */
  confident?: boolean;
}

/**
 * Ask whether the change breaks a rule the repository wrote down.
 *
 * Separate from `review` and run after it, because they answer different
 * questions: that one asks whether the change is any good, this asks whether
 * it breaks something you decided in advance. Merging them would let a strong
 * opinion about code quality arrive wearing the authority of your own rule.
 *
 * The agent reads the diff from the tree itself rather than being handed it,
 * which is why it has `git diff`: passing 60kB of diff through a prompt was
 * the v0.9 approach and truncates on exactly the large change most worth
 * checking.
 */
export async function drift(
  intents: IntentBrief[],
  opts: PhaseOptions,
): Promise<{ violations: DriftViolation[]; costUSD: number; error?: string }> {
  if (intents.length === 0) return { violations: [], costUSD: 0 };

  const outputPath = join(opts.runDir, "drift.json");

  const r = await runAgent<{ violations?: DriftViolation[] }>({
    agent: DRIFT,
    cwd: opts.cwd,
    prompt: [
      "Judge the uncommitted change in this working tree against these rules.",
      "Read the diff with `git diff` and `git status`.",
      "",
      "RULES",
      ...intents.flatMap((i) => [
        `[${i.id}] ${i.headline}`,
        ...i.clauses.map((c) => `  ${c.num ?? "01"} ${c.name}: ${c.text}`),
      ]),
      "",
      `Write your verdict to ${outputPath}`,
    ].join("\n"),
    outputPath,
    allowedTools: [
      "Read", "Grep", "Glob", "Write",
      "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)",
    ],
    permissionMode: "acceptEdits",
    budgetUSD: opts.budgetUSD,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });

  return {
    violations: r.output?.violations ?? [],
    costUSD: r.costUSD,
    error: r.ok ? undefined : r.error,
  };
}

/**
 * Review the change, adversarially.
 *
 * A fresh agent every time, and never the executor resumed: a model handed its
 * own justifications is agreeing with itself, not reviewing. `runAgent` starts
 * a new session on every call, so this is a property of the design rather than
 * something to remember.
 */
export async function review(
  changed: string[],
  opts: PhaseOptions,
): Promise<{ checks: CheckResult[]; costUSD: number; error?: string }> {
  if (changed.length === 0) return { checks: [], costUSD: 0 };

  const outputPath = join(opts.runDir, "review.json");

  const r = await runAgent<{ findings?: CheckResult[] }>({
    agent: REVIEWER,
    cwd: opts.cwd,
    prompt: [
      "Review the change in this working tree. You did not write it.",
      "",
      "Files changed:",
      ...changed.map((f) => `- ${f}`),
      "",
      `Write your findings to ${outputPath}`,
    ].join("\n"),
    outputPath,
    allowedTools: [
      "Read", "Grep", "Glob",
      "Bash(git diff:*)", "Bash(git status:*)", "Bash(npm test:*)", "Bash(pytest:*)",
      "Write",
    ],
    permissionMode: "acceptEdits",
    budgetUSD: opts.budgetUSD,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onOutput: opts.onOutput,
  });

  const findings = r.output?.findings ?? [];
  return {
    checks: findings.map((f) => ({
      kind: "intent" as const,
      label: f.label,
      passed: f.passed,
      detail: f.detail,
    })),
    costUSD: r.costUSD,
    error: r.ok ? undefined : r.error,
  };
}
