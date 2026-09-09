/**
 * How far through the plan the agent has got.
 *
 * The rail shows a numbered plan and then, for minutes, nothing -- so the
 * question "what is the status of the fix" has no answer short of reading the
 * diff yourself. This module answers it from evidence rather than from the
 * agent's own account of itself.
 *
 * **The evidence is the working tree.** A step declares the files it expects
 * to touch; if those files have moved since execution began, that step has
 * demonstrably happened. Nothing here asks the agent whether it is done,
 * because a model reporting its own progress is exactly the thing that cannot
 * be checked -- and the whole point of the handoff is that the checking is
 * mechanical.
 *
 * The cost of that honesty is stated rather than hidden: a step with no
 * declared files can never be more than `unknown`, and a step whose files
 * changed may still have been done *wrong*. This is a progress indicator, not
 * a correctness claim -- the review phase is what judges the work.
 */

import type { Plan, PlanStep } from "./handoff.js";

export type StepState =
  /** Its files have moved since execution began. */
  | "done"
  /** Declared files, none of which have moved yet. */
  | "pending"
  /** No declared files, so the tree cannot say either way. */
  | "unknown";

export interface StepProgress {
  n: number;
  action: string;
  state: StepState;
  /** The declared files that have actually moved. */
  touched: string[];
  /** Declared files still untouched. */
  awaiting: string[];
}

export interface PlanProgress {
  steps: StepProgress[];
  /** Steps proven done by the tree. */
  done: number;
  /** Steps that could be proven either way, i.e. those declaring files. */
  knowable: number;
  /** Files that moved but no step claimed. Worth surfacing: scope creep. */
  unexpected: string[];
}

/**
 * Normalise a declared path for comparison.
 *
 * A plan is written by a model and its paths are approximate: it may say
 * `./flask/lib/x.py`, `flask/lib/x.py` or just `x.py` for the same file. The
 * tree reports one canonical form, so both sides are reduced before matching
 * and a bare basename is allowed to match a full path.
 */
function normalise(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Whether a declared path refers to a changed file. */
function matches(declared: string, changed: Set<string>): string | null {
  const d = normalise(declared);
  if (changed.has(d)) return d;
  // A declared basename matches any changed path ending in it, which is how
  // plans usually refer to a file they have only seen named once.
  if (!d.includes("/")) {
    for (const c of changed) {
      if (c.endsWith(`/${d}`)) return c;
    }
  }
  // And a declared full path matches a changed file with the same tail, for
  // the reverse case: the plan is more specific than the repo root.
  for (const c of changed) {
    if (d.endsWith(`/${c}`) || c.endsWith(`/${d}`)) return c;
  }
  return null;
}

/** Where one step stands, given what has changed. */
export function stepProgress(step: PlanStep, changedPaths: string[]): StepProgress {
  const changed = new Set(changedPaths.map(normalise));
  const declared = (step.files ?? []).filter((f) => f.trim());

  const touched: string[] = [];
  const awaiting: string[] = [];
  for (const f of declared) {
    const hit = matches(f, changed);
    if (hit) touched.push(hit);
    else awaiting.push(normalise(f));
  }

  return {
    n: step.n,
    action: step.action,
    // A step is done when *any* of its files moved, not all of them: plans
    // over-declare, listing files they end up not needing, and demanding every
    // one would leave finished steps showing as pending forever.
    state: declared.length === 0 ? "unknown" : touched.length > 0 ? "done" : "pending",
    touched,
    awaiting,
  };
}

/**
 * The whole plan's progress.
 *
 * `unexpected` is the part worth reading: files that moved which no step
 * claimed. A plan was approved on the strength of what it said it would do, so
 * work outside it is the thing you would want to notice while it is happening
 * rather than at review.
 */
export function planProgress(plan: Plan | undefined, changedPaths: string[]): PlanProgress {
  if (!plan) return { steps: [], done: 0, knowable: 0, unexpected: [] };

  const steps = plan.steps.map((s) => stepProgress(s, changedPaths));

  const claimed = new Set<string>();
  for (const s of steps) for (const t of s.touched) claimed.add(t);

  const unexpected = changedPaths
    .map(normalise)
    .filter((p) => !claimed.has(p))
    .sort();

  return {
    steps,
    done: steps.filter((s) => s.state === "done").length,
    knowable: steps.filter((s) => s.state !== "unknown").length,
    unexpected,
  };
}

/**
 * A one-line summary, honest about what is not knowable.
 *
 * Never "3 of 5 steps": when only three steps declared files, that reads as
 * two steps outstanding when the truth is that two cannot be judged at all.
 */
export function describeProgress(p: PlanProgress): string {
  if (p.steps.length === 0) return "";
  if (p.knowable === 0) return "no step named the files it would touch";

  const parts = [`${p.done} of ${p.knowable} step${p.knowable === 1 ? "" : "s"} done`];
  const silent = p.steps.length - p.knowable;
  if (silent > 0) parts.push(`${silent} cannot be checked`);
  if (p.unexpected.length > 0) {
    parts.push(`${p.unexpected.length} file${p.unexpected.length === 1 ? "" : "s"} no step claimed`);
  }
  return parts.join(" · ");
}
