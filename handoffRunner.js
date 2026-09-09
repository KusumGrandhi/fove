"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HandoffRunner = void 0;
const node_child_process_1 = require("node:child_process");
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
function runClaude(prompt, args, opts) {
    return new Promise((resolve) => {
        const argv = [
            "-p", prompt,
            "--output-format", "json",
            ...(opts.budgetUSD > 0 ? ["--max-budget-usd", String(opts.budgetUSD)] : []),
            ...(opts.sessionId ? ["--resume", opts.sessionId] : []),
            ...args,
        ];
        const child = (0, node_child_process_1.spawn)("claude", argv, {
            cwd: opts.cwd,
            windowsHide: true,
            // A login shell's PATH is where `claude` lives; inherit rather than
            // reconstruct it.
            env: process.env,
            // Its own process group, so a kill reaches the whole tree.
            // `claude` spawns children of its own; signalling only the parent
            // leaves them holding the stdio pipes open, and `close` never fires --
            // which turns a timeout into the same hang it was meant to end.
            detached: true,
        });
        /** Kill the whole group, falling back to the child alone. */
        const killTree = (signal = "SIGTERM") => {
            try {
                if (child.pid)
                    process.kill(-child.pid, signal);
                else
                    child.kill(signal);
            }
            catch {
                // Already gone, or no group: killing the child alone is all that is
                // left to try, and a failure here means it is already dead.
                try {
                    child.kill(signal);
                }
                catch { /* nothing left to do */ }
            }
        };
        let out = "";
        let err = "";
        let size = 0;
        child.stdout.on("data", (c) => {
            size += c.length;
            // A runaway session should not take the app's memory with it.
            if (size > 32 * 1024 * 1024) {
                killTree();
                return;
            }
            out += c.toString();
        });
        child.stderr.on("data", (c) => { err += c.toString().slice(0, 4000); });
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
                const parsed = JSON.parse(out);
                resolve({
                    ok: parsed.is_error !== true,
                    structured: parsed.structured_output,
                    text: parsed.result ?? "",
                    costUSD: parsed.total_cost_usd ?? 0,
                    sessionId: parsed.session_id,
                    denials: (parsed.permission_denials ?? []).length,
                });
            }
            catch {
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
class HandoffRunner {
    /**
     * Produce a plan without touching the working tree.
     *
     * `--permission-mode plan` is the safety property, verified rather than
     * trusted: asked to modify a file in a scratch repository, it left the file
     * unchanged. A plan that edited files on the way to being proposed would not
     * be a proposal.
     */
    async plan(ticket, intents, opts) {
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
        return { plan: r.structured, sessionId: r.sessionId, costUSD: r.costUSD };
    }
    /**
     * Execute an approved plan.
     *
     * `acceptEdits` rather than `bypassPermissions`: edits proceed, but anything
     * outside that -- a shell command with consequences, a network call -- still
     * stops. The plan was approved, not a blank cheque.
     */
    async execute(plan, opts) {
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
    async check(changed, mechanisms, runMechanism, opts) {
        const checks = [];
        for (const m of mechanisms) {
            const r = await runMechanism(m.command);
            checks.push({
                kind: "mechanism",
                label: m.label,
                passed: r.passed,
                detail: r.passed ? undefined : r.output.slice(0, 400),
            });
        }
        if (changed.length === 0)
            return { checks, costUSD: 0 };
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
        const findings = r.structured?.findings ?? [];
        for (const f of findings) {
            checks.push({ kind: "intent", label: f.label, passed: f.passed, detail: f.detail });
        }
        return { checks, costUSD: r.costUSD };
    }
}
exports.HandoffRunner = HandoffRunner;
//# sourceMappingURL=handoffRunner.js.map