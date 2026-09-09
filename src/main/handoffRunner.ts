/**
 * Driving `claude` through the handoff loop.
 *
 * `shared/handoff.ts` says which phase follows which; this makes each phase
 * happen. Every capability it relies on was checked against the installed CLI
 * before being designed around, not assumed from the help text:
 *
 *   - `--json-schema` returns a **validated, typed object** in
 *     `structured_output`. That is what makes a plan data rather than prose to
 *     scrape, and it is the single feature this whole loop rests on.
 *   - `--permission-mode plan` genuinely cannot write. Verified by asking it to
 *     modify a file in a scratch repo and finding the file untouched.
 *   - `--max-budget-usd` caps spend per invocation.
 *   - the result carries `total_cost_usd`, `permission_denials` and a
 *     `session_id`, so cost is measured rather than estimated and later phases
 *     resume the same conversation.
 *
 * The loop stops at *ready to review*. There is no merge step, here or
 * anywhere: Keel assembles evidence and the judgment stays yours.
 */

import { spawn } from "node:child_process";
import type { Plan, CheckResult } from "../shared/handoff.js";
import { spawnEnv } from "./loginPath.js";

/** What one `claude -p` invocation returned. */
interface ClaudeResult {
  ok: boolean;
  /** Parsed `structured_output` when a schema was given. */
  structured?: unknown;
  text: string;
  costUSD: number;
  sessionId?: string;
  denials: number;
  error?: string;
}

/**
 * The shape a plan must arrive in.
 *
 * `risks` is the field that earns its place: what the agent believes it cannot
 * decide. The handoff caps the human's open questions at three, and this is
 * where most of them come from.
 */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          action: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["n", "action"],
      },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "steps"],
};

/**
 * A drift verdict: which intent clauses the diff contradicts.
 *
 * `clause` is cited by id so the answer can be attached to the rule it is
 * about rather than parsed out of prose, and `evidence` is required because a
 * drift claim nobody can check is worth less than no claim at all.
 */
const DRIFT_SCHEMA = {
  type: "object",
  properties: {
    violations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          intentId: { type: "string" },
          clause: { type: "string" },
          file: { type: "string" },
          evidence: { type: "string" },
          confident: { type: "boolean" },
        },
        required: ["intentId", "clause", "file", "evidence"],
      },
    },
  },
  required: ["violations"],
};

/** A review verdict, for the checking phase. */
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          passed: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["label", "passed"],
      },
    },
  },
  required: ["findings"],
};

/** One rule the diff was judged to break. */
export interface DriftViolation {
  intentId: string;
  /** Clause number within that intent, e.g. "01". */
  clause: string;
  file: string;
  /** The line or construct that breaks it, quoted from the diff. */
  evidence: string;
  /** False when the reviewer was inferring rather than reading a clear breach. */
  confident?: boolean;
}

export interface RunOptions {
  cwd: string;
  budgetUSD: number;
  /** Resume an existing conversation, so later phases keep the context. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Override the wall-clock ceiling, in ms. See `PHASE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * How long one phase may run before it is killed.
 *
 * The budget caps *usage*, which is not the same thing: a `claude` that hangs
 * without producing tokens costs nothing and would otherwise wait forever,
 * with the UI showing "planning" indefinitely and no way to tell it from work.
 *
 * Twenty minutes is deliberately generous. Planning a real ticket means
 * fetching it, reading the codebase and reasoning about it -- several minutes
 * is normal, and a ceiling that fires during honest work would be worse than
 * none. This is the "something is wrong" bound, not a performance target.
 */
const PHASE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run `claude -p` once and parse its result.
 *
 * Never throws: a failed invocation returns `ok: false` with whatever was
 * read. A loop that crashes on a non-zero exit is worse than one that reports
 * it, because the working tree may already have changes in it.
 */
async function runClaude(
  prompt: string,
  args: string[],
  opts: RunOptions,
): Promise<ClaudeResult> {
  // Resolved before spawning: a Finder-launched app cannot find `claude` on
  // its inherited PATH. See `loginPath`.
  const env = await spawnEnv();

  return new Promise((resolve) => {
    const argv = [
      "-p", prompt,
      "--output-format", "json",
      ...(opts.budgetUSD > 0 ? ["--max-budget-usd", String(opts.budgetUSD)] : []),
      ...(opts.sessionId ? ["--resume", opts.sessionId] : []),
      ...args,
    ];

    const child = spawn("claude", argv, {
      cwd: opts.cwd,
      windowsHide: true,
      env,
      // Its own process group, so a kill reaches the whole tree.
      // `claude` spawns children of its own; signalling only the parent
      // leaves them holding the stdio pipes open, and `close` never fires --
      // which turns a timeout into the same hang it was meant to end.
      detached: true,
    });

    /** Kill the whole group, falling back to the child alone. */
    const killTree = (signal: NodeJS.Signals = "SIGTERM"): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone, or no group: killing the child alone is all that is
        // left to try, and a failure here means it is already dead.
        try { child.kill(signal); } catch { /* nothing left to do */ }
      }
    };

    let out = "";
    let err = "";
    let size = 0;

    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      // A runaway session should not take the app's memory with it.
      if (size > 32 * 1024 * 1024) { killTree(); return; }
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => { err += c.toString().slice(0, 4000); });

    opts.signal?.addEventListener("abort", () => killTree(), { once: true });

    // A phase that produces nothing forever is indistinguishable from one
    // doing careful work, so it needs a wall-clock bound of its own.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // SIGTERM is a request. If the tree is still there shortly after, stop
      // asking -- otherwise the timeout has simply moved the hang later.
      setTimeout(() => killTree("SIGKILL"), 2000).unref?.();
    }, opts.timeoutMs ?? PHASE_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: "", costUSD: 0, denials: 0, error: e.message });
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        const mins = Math.round((opts.timeoutMs ?? PHASE_TIMEOUT_MS) / 60000);
        resolve({
          ok: false, text: "", costUSD: 0, denials: 0,
          error: `no result after ${mins} minutes — stopped`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(out) as {
          is_error?: boolean;
          result?: string;
          structured_output?: unknown;
          total_cost_usd?: number;
          session_id?: string;
          permission_denials?: unknown[];
        };
        resolve({
          ok: parsed.is_error !== true,
          structured: parsed.structured_output,
          text: parsed.result ?? "",
          costUSD: parsed.total_cost_usd ?? 0,
          sessionId: parsed.session_id,
          denials: (parsed.permission_denials ?? []).length,
        });
      } catch {
        // Not JSON: the CLI failed before producing a result. Whatever is on
        // stderr is the useful part.
        resolve({
          ok: false, text: out.slice(0, 2000), costUSD: 0, denials: 0,
          error: err.trim() || "claude produced no parseable result",
        });
      }
    });
  });
}

export class HandoffRunner {
  /**
   * Produce a plan without touching the working tree.
   *
   * `--permission-mode plan` is the safety property, verified rather than
   * trusted: asked to modify a file in a scratch repository, it left the file
   * unchanged. A plan that edited files on the way to being proposed would not
   * be a proposal.
   */
  async plan(
    ticket: string,
    intents: { id: string; headline: string; clauses: { name: string; text: string }[] }[],
    opts: RunOptions,
  ): Promise<{ plan?: Plan; sessionId?: string; costUSD: number; error?: string }> {
    const rules = intents.length
      ? [
          "",
          "This codebase has rules that must stay true. Say in `risks` if the task",
          "cannot be done without breaking one, and name the rule:",
          ...intents.flatMap((i) => [
            `- ${i.headline}`,
            ...i.clauses.map((c) => `  - ${c.name}: ${c.text}`),
          ]),
        ].join("\n")
      : "";

    const prompt = [
      "Plan this task. Do not edit anything; produce a plan only.",
      "",
      `Task: ${ticket}`,
      rules,
      "",
      "Keep steps concrete and few. In `risks`, list anything you cannot decide",
      "alone -- a choice with consequences, a rule that might be broken, or",
      "something you could not verify. Be specific; an empty list is fine if the",
      "task is genuinely unambiguous.",
    ].join("\n");

    const r = await runClaude(prompt, [
      "--permission-mode", "plan",
      "--json-schema", JSON.stringify(PLAN_SCHEMA),
    ], opts);

    if (!r.ok || !r.structured) {
      return { costUSD: r.costUSD, error: r.error ?? "no plan came back" };
    }
    return { plan: r.structured as Plan, sessionId: r.sessionId, costUSD: r.costUSD };
  }

  /**
   * Execute an approved plan.
   *
   * `acceptEdits` rather than `bypassPermissions`: edits proceed, but anything
   * outside that -- a shell command with consequences, a network call -- still
   * stops. The plan was approved, not a blank cheque.
   */
  async execute(
    plan: Plan,
    opts: RunOptions,
  ): Promise<{ ok: boolean; costUSD: number; denials: number; error?: string }> {
    const prompt = [
      "Carry out this plan exactly. Do not expand its scope.",
      "",
      `Goal: ${plan.summary}`,
      ...plan.steps.map((s) => `${s.n}. ${s.action}`),
      "",
      "If a step turns out to be wrong or impossible, stop and say so rather",
      "than improvising a different approach.",
    ].join("\n");

    const r = await runClaude(prompt, ["--permission-mode", "acceptEdits"], opts);
    return { ok: r.ok, costUSD: r.costUSD, denials: r.denials, error: r.error };
  }

  /**
   * Ask a *second* agent which intents the diff contradicts.
   *
   * This is the discriminator, and the distinction it rests on is the one that
   * makes it worth running at all: a model asked "did you follow the rules?"
   * is grading its own homework, and models are weakest exactly there. A model
   * shown a diff it did not write, and a list of rules, is doing a different
   * job -- reading code for violations, which is ordinary review work.
   *
   * So it runs in a **fresh session**: `sessionId` is deliberately not passed
   * through. Resuming the writer's conversation would hand it every
   * justification it already told itself, which is the thing being checked.
   *
   * `--permission-mode plan` because a reviewer must not edit, and the diff is
   * passed inline rather than as paths so the verdict is about what actually
   * changed rather than whatever the file says by the time it is read.
   */
  async drift(
    diff: string,
    intents: { id: string; headline: string; clauses: { num: string; name: string; text: string }[] }[],
    opts: RunOptions,
  ): Promise<{ violations: DriftViolation[]; costUSD: number; error?: string }> {
    if (!diff.trim() || intents.length === 0) return { violations: [], costUSD: 0 };

    const rules = intents.flatMap((i) => [
      `[${i.id}] ${i.headline}`,
      ...i.clauses.map((c) => `  ${c.num} ${c.name}: ${c.text}`),
    ]);

    const prompt = [
      "You are reviewing someone else's change. You did not write it.",
      "",
      "Below are rules this codebase must keep true, then the diff. Report only",
      "rules the diff actually breaks.",
      "",
      "RULES",
      ...rules,
      "",
      "DIFF",
      diff.slice(0, 60_000),
      "",
      "For each violation give the intent id, the clause number, the file, and",
      "the specific line or construct that breaks it. Quote it -- a claim with",
      "no evidence is worse than no claim, because someone has to go and check",
      "it either way.",
      "",
      "Set confident=false when the rule is ambiguous or you are inferring intent",
      "rather than reading a clear breach. Report nothing if nothing is broken:",
      "an empty list is the expected answer for most changes, and inventing a",
      "violation to look useful makes every real one worth less.",
    ].join("\n");

    // A fresh session on purpose -- see the note above. `sessionId` is dropped.
    const r = await runClaude(prompt, [
      "--permission-mode", "plan",
      "--json-schema", JSON.stringify(DRIFT_SCHEMA),
    ], { ...opts, sessionId: undefined });

    if (!r.ok || !r.structured) {
      return { violations: [], costUSD: r.costUSD, error: r.error ?? "no verdict came back" };
    }
    const out = (r.structured as { violations?: DriftViolation[] }).violations ?? [];
    return { violations: out, costUSD: r.costUSD };
  }

  /**
   * Check the work: deterministic mechanisms first, then a review.
   *
   * The order is the point. A mechanism is a search and gives a verdict that
   * does not depend on anyone's judgment; the review is a judgment and is
   * labelled as one. They are never merged into a single "looks good".
   */
  async check(
    changed: string[],
    mechanisms: { label: string; command: string }[],
    runMechanism: (command: string) => Promise<{ passed: boolean; output: string }>,
    opts: RunOptions,
  ): Promise<{ checks: CheckResult[]; costUSD: number }> {
    const checks: CheckResult[] = [];

    for (const m of mechanisms) {
      const r = await runMechanism(m.command);
      checks.push({
        kind: "mechanism",
        label: m.label,
        passed: r.passed,
        detail: r.passed ? undefined : r.output.slice(0, 400),
      });
    }

    if (changed.length === 0) return { checks, costUSD: 0 };

    const prompt = [
      "Review the changes you just made, adversarially. You are looking for what",
      "is wrong, not confirming that it is right.",
      "",
      "Files changed:",
      ...changed.map((f) => `- ${f}`),
      "",
      "Report each concern as a finding with passed=false. Only report things you",
      "can point at in the diff -- a caller that was not updated, an input that",
      "would break it, an edge case the change misses. If you genuinely find",
      "nothing, return a single finding with passed=true saying so.",
    ].join("\n");

    const r = await runClaude(prompt, [
      "--permission-mode", "plan",
      "--json-schema", JSON.stringify(REVIEW_SCHEMA),
    ], opts);

    const findings = (r.structured as { findings?: CheckResult[] } | undefined)?.findings ?? [];
    for (const f of findings) {
      checks.push({ kind: "intent", label: f.label, passed: f.passed, detail: f.detail });
    }

    return { checks, costUSD: r.costUSD };
  }
}
