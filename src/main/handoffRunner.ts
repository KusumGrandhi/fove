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

export interface RunOptions {
  cwd: string;
  budgetUSD: number;
  /** Resume an existing conversation, so later phases keep the context. */
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Run `claude -p` once and parse its result.
 *
 * Never throws: a failed invocation returns `ok: false` with whatever was
 * read. A loop that crashes on a non-zero exit is worse than one that reports
 * it, because the working tree may already have changes in it.
 */
function runClaude(
  prompt: string,
  args: string[],
  opts: RunOptions,
): Promise<ClaudeResult> {
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
      // A login shell's PATH is where `claude` lives; inherit rather than
      // reconstruct it.
      env: process.env,
    });

    let out = "";
    let err = "";
    let size = 0;

    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      // A runaway session should not take the app's memory with it.
      if (size > 32 * 1024 * 1024) { child.kill(); return; }
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => { err += c.toString().slice(0, 4000); });

    opts.signal?.addEventListener("abort", () => child.kill(), { once: true });

    child.on("error", (e) =>
      resolve({ ok: false, text: "", costUSD: 0, denials: 0, error: e.message }));

    child.on("close", () => {
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
