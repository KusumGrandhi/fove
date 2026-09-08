/**
 * The handoff loop's state machine.
 *
 * These are the safety rules, so they are tested as rules rather than as a
 * happy path. Three matter more than the rest:
 *
 *   - a plan is approved before it runs
 *   - a *revised* plan is unapproved again, so an agent cannot change course
 *     quietly by rewriting the plan mid-execution
 *   - the loop ends at `ready`, never at merged
 */

import { describe, expect, it } from "vitest";
import {
  initial, reduce, mayExecute, needsYou, isRunning, describe as describePhase,
  openQuestions, type HandoffState, type Plan,
} from "../src/shared/handoff.js";

const plan = (summary = "do the thing", over: Partial<Plan> = {}): Plan => ({
  summary,
  steps: [{ n: 1, action: "edit a file" }],
  ...over,
});

const started = (budget = 5): HandoffState =>
  reduce(initial(), { type: "start", ticket: "add a health endpoint", budgetUSD: budget });

const planned = (budget = 5): HandoffState =>
  reduce(started(budget), { type: "planned", plan: plan(), sessionId: "s1", costUSD: 0.2 });

const approved = (budget = 5): HandoffState =>
  reduce(planned(budget), { type: "approve" });

describe("the phases", () => {
  it("starts in idle and plans first", () => {
    expect(initial().phase).toBe("idle");
    expect(started().phase).toBe("planning");
  });

  it("goes planning → awaiting-approval, never straight to executing", () => {
    // The gate. A plan that ran without being shown is not a plan.
    expect(planned().phase).toBe("awaiting-approval");
  });

  it("runs the full loop to ready", () => {
    let s = approved();
    expect(s.phase).toBe("executing");
    s = reduce(s, { type: "executed", costUSD: 1.1 });
    expect(s.phase).toBe("checking");
    s = reduce(s, { type: "checked", checks: [] });
    expect(s.phase).toBe("ready");
  });

  it("ends at ready, not at merged", () => {
    // There is no "merge" event, by design. Keel assembles evidence; the
    // judgment is not its to make.
    let s = reduce(reduce(approved(), { type: "executed", costUSD: 1 }), {
      type: "checked", checks: [],
    });
    expect(s.phase).toBe("ready");
    // Nothing carries it further.
    s = reduce(s, { type: "executed", costUSD: 1 });
    expect(s.phase).toBe("ready");
  });

  it("can start a new ticket from ready or stopped, but not mid-flight", () => {
    const ready = reduce(reduce(approved(), { type: "executed", costUSD: 1 }), {
      type: "checked", checks: [],
    });
    expect(reduce(ready, { type: "start", ticket: "next", budgetUSD: 1 }).phase).toBe("planning");

    // Starting over mid-execution would abandon work silently.
    expect(reduce(approved(), { type: "start", ticket: "next", budgetUSD: 1 }).phase)
      .toBe("executing");
  });
});

describe("approval", () => {
  it("will not execute an unapproved plan", () => {
    expect(mayExecute(planned())).toBe(false);
  });

  it("executes once approved", () => {
    expect(mayExecute(approved())).toBe(true);
  });

  it("cannot approve when there is no plan", () => {
    expect(reduce(started(), { type: "approve" }).phase).toBe("planning");
  });

  it("un-approves a plan that was revised after approval", () => {
    /*
     * The rule that stops an agent changing course quietly. It may propose a
     * different plan, but the approval it was given was for the plan it had,
     * and that approval does not transfer to a new one.
     */
    let s = approved();
    expect(mayExecute(s)).toBe(true);

    s = reduce(s, { type: "replan", plan: plan("a different approach"), costUSD: 0.1 });
    expect(s.phase).toBe("awaiting-approval");
    expect(s.approvedRevision).toBeUndefined();
    expect(mayExecute(s)).toBe(false);

    // And re-approving works, for the new revision.
    s = reduce(s, { type: "approve" });
    expect(mayExecute(s)).toBe(true);
  });

  it("tracks revisions so a stale approval cannot be reused", () => {
    let s = approved();
    const firstApproval = s.approvedRevision;
    s = reduce(s, { type: "replan", plan: plan("v2"), costUSD: 0 });
    expect(s.planRevision).toBeGreaterThan(firstApproval!);
  });
});

describe("the usage cap", () => {
  it("stops during planning when the cap is reached", () => {
    /*
     * A ceiling on how much work a runaway task may do. The CLI reports usage
     * in dollars because that is what the tokens cost at API rates, but this
     * machine authenticates by OAuth with no API key -- so it is subscription
     * usage, not a charge, and the wording says so.
     */
    const s = reduce(started(0.1), {
      type: "planned", plan: plan(), costUSD: 0.5,
    });
    expect(s.phase).toBe("stopped");
    expect(s.stoppedReason).toContain("usage cap");
  });

  it("still checks work that finished over the cap", () => {
    /*
     * The usage is spent and the changes exist on disk. Refusing to look at
     * them helps nobody -- the cap prevents *more* work, it is not a reason to
     * abandon what was already done.
     */
    const s = reduce(approved(0.5), { type: "executed", costUSD: 10 });
    expect(s.phase).toBe("checking");
  });

  it("accumulates cost across phases", () => {
    const s = reduce(approved(), { type: "executed", costUSD: 1.3 });
    expect(s.costUSD).toBeCloseTo(1.5, 2);
  });

  it("treats zero as no cap", () => {
    const s = reduce(reduce(initial(), { type: "start", ticket: "t", budgetUSD: 0 }), {
      type: "planned", plan: plan(), costUSD: 99,
    });
    expect(s.phase).toBe("awaiting-approval");
  });
});

describe("stopping", () => {
  it("stops from any running phase", () => {
    for (const s of [started(), planned(), approved()]) {
      expect(reduce(s, { type: "stop", reason: "you stopped it" }).phase).toBe("stopped");
    }
  });

  it("will not un-ready finished work", () => {
    const ready = reduce(reduce(approved(), { type: "executed", costUSD: 1 }), {
      type: "checked", checks: [],
    });
    expect(reduce(ready, { type: "stop", reason: "late" }).phase).toBe("ready");
  });

  it("records why", () => {
    const s = reduce(approved(), { type: "failed", reason: "claude exited 1" });
    expect(s.stoppedReason).toBe("claude exited 1");
    expect(s.endedAt).toBeDefined();
  });
});

describe("out-of-order events", () => {
  it("ignores an event that arrives in the wrong phase", () => {
    // A check finishing after a stop is a race, not a bug worth crashing on.
    const stopped = reduce(approved(), { type: "stop", reason: "x" });
    expect(reduce(stopped, { type: "checked", checks: [] }).phase).toBe("stopped");
  });

  it("ignores a plan arriving when not planning", () => {
    expect(reduce(approved(), { type: "planned", plan: plan(), costUSD: 1 }).phase)
      .toBe("executing");
  });
});

describe("reporting", () => {
  it("knows when it is working and when it needs you", () => {
    expect(isRunning(started())).toBe(true);
    expect(needsYou(started())).toBe(false);
    expect(needsYou(planned())).toBe(true);
  });

  it("says a revised plan needs approving again", () => {
    const s = reduce(approved(), { type: "replan", plan: plan("v2"), costUSD: 0 });
    expect(describePhase(s)).toContain("again");
  });

  it("names failed checks in the ready state", () => {
    const s = reduce(reduce(approved(), { type: "executed", costUSD: 1 }), {
      type: "checked",
      checks: [
        { kind: "mechanism", label: "no print()", passed: false },
        { kind: "test", label: "pytest", passed: true },
      ],
    });
    expect(describePhase(s)).toContain("1 check failed");
  });

  it("says planning is not editing anything", () => {
    // Worth saying plainly: it is the phase people are most nervous about.
    expect(describePhase(started())).toContain("nothing is being edited");
  });
});

describe("open questions", () => {
  it("caps at three, because more means the task was too wide", () => {
    const s = reduce(started(), {
      type: "planned",
      plan: plan("x", { risks: ["a", "b", "c", "d", "e"] }),
      costUSD: 0,
    });
    expect(openQuestions(s)).toHaveLength(3);
  });

  it("includes failed checks alongside declared risks", () => {
    let s = reduce(started(), {
      type: "planned", plan: plan("x", { risks: ["public API shape"] }), costUSD: 0,
    });
    s = reduce(reduce(s, { type: "approve" }), { type: "executed", costUSD: 0 });
    s = reduce(s, {
      type: "checked",
      checks: [{ kind: "intent", label: "no raw SQL", passed: false, detail: "2 hits" }],
    });
    const qs = openQuestions(s);
    expect(qs[0]).toBe("public API shape");
    expect(qs[1]).toContain("no raw SQL");
  });

  it("is empty when nothing needs deciding", () => {
    expect(openQuestions(initial())).toEqual([]);
  });
});
