/**
 * The handoff loop: ticket in, reviewable work out.
 *
 * You hand Keel a task. It plans without touching anything, you approve the
 * plan, it executes, it checks its own work against your intents, and it stops
 * at *ready to review* -- never at *merged*. The last step is always yours.
 *
 * This module is the state machine only: which phase follows which, what may
 * happen in each, and what makes a transition legal. Pure, because the phase
 * rules are the safety story and belong somewhere they can be proved rather
 * than inspected.
 *
 * Three properties it exists to enforce:
 *
 *   - **Planning cannot write.** The plan phase runs under `--permission-mode
 *     plan`, verified against real `claude` to leave the working tree
 *     untouched. A plan is a proposal, and a proposal that edited files on the
 *     way to being proposed is not one.
 *   - **A plan is approved before it runs.** The gate is a human's, and a
 *     revised plan re-opens it -- an agent cannot change course quietly by
 *     rewriting the plan mid-execution.
 *   - **The loop never ends at merged.** `ready` is terminal. Keel assembles
 *     evidence; the judgment is not its to make.
 */

export type Phase =
  /** Nothing running. */
  | "idle"
  /** Producing a plan, under a permission mode that cannot edit. */
  | "planning"
  /** A plan exists and is waiting for a human. The gate. */
  | "awaiting-approval"
  /** Approved and running, with edits allowed. */
  | "executing"
  /** Work done; running mechanisms and looking for risk. */
  | "checking"
  /** Evidence assembled, waiting for review. Terminal. */
  | "ready"
  /** Stopped by a person, a budget cap, or an error. Terminal. */
  | "stopped";

export interface PlanStep {
  n: number;
  action: string;
  /** Files the step expects to touch. Advisory: used to flag surprises. */
  files?: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  /** Intents the agent believes this task touches, by id. */
  intents?: string[];
  /** What it says it cannot do or decide. The most useful field. */
  risks?: string[];
}

/** A check run after execution. */
export interface CheckResult {
  kind: "mechanism" | "intent" | "test";
  label: string;
  passed: boolean;
  detail?: string;
}

export interface HandoffState {
  phase: Phase;
  /** What was asked, verbatim. */
  ticket: string;
  plan?: Plan;
  /** Bumped whenever a new plan replaces an approved one. */
  planRevision: number;
  approvedRevision?: number;
  /**
   * True once a plan has been replaced after being approved.
   *
   * Distinct from `approvedRevision`, which a revision clears -- without this
   * the UI could not tell "here is a plan" from "the plan you approved has
   * changed", and the second is the one worth interrupting someone for.
   */
  planChangedAfterApproval?: boolean;
  checks: CheckResult[];
  /** Claude's session id, for resuming the same conversation across phases. */
  sessionId?: string;
  costUSD: number;
  /** Hard cap. Crossing it stops the loop rather than asking. */
  budgetUSD: number;
  startedAt: number;
  endedAt?: number;
  /** Why it stopped, when it stopped for a reason worth showing. */
  stoppedReason?: string;
}

/** Events the loop responds to. */
export type HandoffEvent =
  | { type: "start"; ticket: string; budgetUSD: number }
  | { type: "planned"; plan: Plan; sessionId?: string; costUSD: number }
  | { type: "approve" }
  | { type: "executed"; costUSD: number }
  | { type: "checked"; checks: CheckResult[] }
  | { type: "replan"; plan: Plan; costUSD: number }
  | { type: "stop"; reason: string }
  | { type: "failed"; reason: string };

export function initial(): HandoffState {
  return {
    phase: "idle",
    ticket: "",
    planRevision: 0,
    checks: [],
    costUSD: 0,
    budgetUSD: 0,
    startedAt: 0,
  };
}

/**
 * Advance the loop.
 *
 * Unknown transitions are ignored rather than throwing: an event arriving in
 * the wrong phase is a race (a check finishing after a stop, say), and dropping
 * it is right where crashing the pane is not.
 */
export function reduce(state: HandoffState, event: HandoffEvent): HandoffState {
  switch (event.type) {
    case "start":
      if (state.phase !== "idle" && state.phase !== "ready" && state.phase !== "stopped") {
        return state;
      }
      return {
        ...initial(),
        phase: "planning",
        ticket: event.ticket,
        budgetUSD: event.budgetUSD,
        startedAt: Date.now(),
      };

    case "planned": {
      if (state.phase !== "planning") return state;
      const cost = state.costUSD + event.costUSD;
      // The budget is a cap, not a warning. Crossing it during planning means
      // execution never starts.
      if (overBudget(state, cost)) {
        return { ...state, phase: "stopped", costUSD: cost, endedAt: Date.now(),
          stoppedReason: `budget of $${state.budgetUSD.toFixed(2)} reached while planning` };
      }
      return {
        ...state,
        phase: "awaiting-approval",
        plan: event.plan,
        planRevision: state.planRevision + 1,
        sessionId: event.sessionId ?? state.sessionId,
        costUSD: cost,
      };
    }

    case "approve":
      // Only a plan that exists and is currently on the gate may be approved.
      if (state.phase !== "awaiting-approval" || !state.plan) return state;
      return { ...state, phase: "executing", approvedRevision: state.planRevision };

    case "replan": {
      /*
       * A revised plan goes back to the gate, always.
       *
       * This is the rule that stops an agent changing course quietly: it may
       * propose a different plan, but the approval it was given was for the
       * plan it had, and that approval does not transfer.
       */
      if (state.phase !== "executing" && state.phase !== "awaiting-approval") return state;
      const cost = state.costUSD + event.costUSD;
      if (overBudget(state, cost)) {
        return { ...state, phase: "stopped", costUSD: cost, endedAt: Date.now(),
          stoppedReason: `budget of $${state.budgetUSD.toFixed(2)} reached` };
      }
      return {
        ...state,
        phase: "awaiting-approval",
        plan: event.plan,
        planRevision: state.planRevision + 1,
        approvedRevision: undefined,
        planChangedAfterApproval: state.approvedRevision !== undefined,
        costUSD: cost,
      };
    }

    case "executed": {
      if (state.phase !== "executing") return state;
      const cost = state.costUSD + event.costUSD;
      // Over budget after the work is done: still check it. The money is spent
      // and the changes exist, so refusing to look at them helps nobody.
      return { ...state, phase: "checking", costUSD: cost };
    }

    case "checked":
      if (state.phase !== "checking") return state;
      return { ...state, phase: "ready", checks: event.checks, endedAt: Date.now() };

    case "stop":
      if (state.phase === "ready") return state;
      return { ...state, phase: "stopped", stoppedReason: event.reason, endedAt: Date.now() };

    case "failed":
      return { ...state, phase: "stopped", stoppedReason: event.reason, endedAt: Date.now() };

    default:
      return state;
  }
}

function overBudget(state: HandoffState, cost: number): boolean {
  return state.budgetUSD > 0 && cost >= state.budgetUSD;
}

/** Whether the loop is doing something, for spinners and "do not close" hints. */
export function isRunning(state: HandoffState): boolean {
  return state.phase === "planning" || state.phase === "executing" || state.phase === "checking";
}

/** Whether a human is being waited on. */
export function needsYou(state: HandoffState): boolean {
  return state.phase === "awaiting-approval" || state.phase === "ready";
}

/**
 * Whether execution may proceed.
 *
 * The approval must be for *this* revision. A plan revised after approval is
 * unapproved again, which is the whole point of tracking the revision.
 */
export function mayExecute(state: HandoffState): boolean {
  return state.phase === "executing" && state.approvedRevision === state.planRevision;
}

/** A one-line description of where the loop is, for a status pill. */
export function describe(state: HandoffState): string {
  switch (state.phase) {
    case "idle": return "nothing running";
    case "planning": return "planning — nothing is being edited";
    case "awaiting-approval":
      return state.planChangedAfterApproval
        ? "the plan changed — approve it again"
        : "waiting for you to approve the plan";
    case "executing": return `executing step-by-step · $${state.costUSD.toFixed(2)}`;
    case "checking": return "checking its own work";
    case "ready": {
      const failed = state.checks.filter((c) => !c.passed).length;
      return failed > 0
        ? `ready to review · ${failed} check${failed === 1 ? "" : "s"} failed`
        : "ready to review";
    }
    case "stopped": return state.stoppedReason ?? "stopped";
  }
}

/**
 * What a human still has to decide, capped at three.
 *
 * The handoff's rule: more than three means the task was scoped too widely.
 * The cap is the signal, so it is applied here rather than left to the UI.
 */
export function openQuestions(state: HandoffState): string[] {
  const out: string[] = [];
  for (const r of state.plan?.risks ?? []) out.push(r);
  for (const c of state.checks) {
    if (!c.passed) out.push(`${c.label} — ${c.detail ?? "failed"}`);
  }
  return out.slice(0, 3);
}
