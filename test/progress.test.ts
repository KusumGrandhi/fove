/**
 * Step status, derived from the tree rather than from the agent.
 *
 * The rule this module exists to keep: nothing here asks the agent how it is
 * doing. A step is done when the files it said it would touch have moved,
 * because that is checkable and self-report is not.
 *
 * The tests are mostly about what it refuses to claim -- a step that declared
 * no files is `unknown`, never `pending`, and the summary says so rather than
 * quietly counting it as outstanding work.
 */

import { describe, expect, it } from "vitest";
import { planProgress, stepProgress, describeProgress } from "../src/shared/progress.js";
import type { Plan } from "../src/shared/handoff.js";

const plan = (steps: Plan["steps"]): Plan => ({ summary: "s", steps });

describe("one step", () => {
  it("is done when a declared file has moved", () => {
    const p = stepProgress(
      { n: 1, action: "edit the helper", files: ["flask/lib/helpers.py"] },
      ["flask/lib/helpers.py"],
    );
    expect(p.state).toBe("done");
    expect(p.touched).toEqual(["flask/lib/helpers.py"]);
  });

  it("is pending while its files are untouched", () => {
    const p = stepProgress(
      { n: 1, action: "edit the helper", files: ["flask/lib/helpers.py"] },
      ["something/else.py"],
    );
    expect(p.state).toBe("pending");
    expect(p.awaiting).toEqual(["flask/lib/helpers.py"]);
  });

  it("is unknown when the step named no files", () => {
    /*
     * The distinction that keeps the count honest. A step with no declared
     * files is not outstanding work -- it is work whose status the tree cannot
     * report, and calling it "pending" would be a claim we cannot support.
     */
    const p = stepProgress({ n: 1, action: "think about it" }, ["a.py"]);
    expect(p.state).toBe("unknown");
  });

  it("is done when ANY declared file moved, not all of them", () => {
    /*
     * Plans over-declare: they list files they turn out not to need. Requiring
     * every one would leave finished steps showing as pending forever.
     */
    const p = stepProgress(
      { n: 1, action: "edit two things", files: ["a.py", "b.py"] },
      ["a.py"],
    );
    expect(p.state).toBe("done");
    expect(p.touched).toEqual(["a.py"]);
    expect(p.awaiting).toEqual(["b.py"]);
  });
});

describe("matching approximate paths", () => {
  it("ignores a leading ./", () => {
    const p = stepProgress({ n: 1, action: "x", files: ["./a/b.py"] }, ["a/b.py"]);
    expect(p.state).toBe("done");
  });

  it("matches a bare basename against a full path", () => {
    // Plans routinely name a file the way a person would, not by full path.
    const p = stepProgress({ n: 1, action: "x", files: ["checklist.py"] },
      ["flask/core/aggregator/mappers/checklist.py"]);
    expect(p.state).toBe("done");
  });

  it("does not match a basename that merely appears inside another name", () => {
    // `list.py` must not match `checklist.py`: the segment has to be whole.
    const p = stepProgress({ n: 1, action: "x", files: ["list.py"] },
      ["flask/core/checklist.py"]);
    expect(p.state).toBe("pending");
  });
});

describe("the whole plan", () => {
  const steps = [
    { n: 1, action: "helpers", files: ["helpers.py"] },
    { n: 2, action: "mapper", files: ["checklist.py"] },
    { n: 3, action: "think", files: [] },
  ];

  it("counts only steps whose status is knowable", () => {
    const p = planProgress(plan(steps), ["helpers.py"]);
    expect(p.done).toBe(1);
    expect(p.knowable).toBe(2);        // step 3 declared nothing
    expect(describeProgress(p)).toContain("1 of 2 steps done");
    expect(describeProgress(p)).toContain("1 cannot be checked");
  });

  it("names files that moved which no step claimed", () => {
    /*
     * The plan was approved on the strength of what it said it would do, so
     * work outside it is worth noticing while it happens rather than at review.
     */
    const p = planProgress(plan(steps), ["helpers.py", "surprise.py"]);
    expect(p.unexpected).toEqual(["surprise.py"]);
    expect(describeProgress(p)).toContain("1 file no step claimed");
  });

  it("says so plainly when no step named any file", () => {
    const p = planProgress(plan([{ n: 1, action: "do it" }]), ["a.py"]);
    expect(p.knowable).toBe(0);
    expect(describeProgress(p)).toBe("no step named the files it would touch");
  });

  it("reports nothing at all before there is a plan", () => {
    const p = planProgress(undefined, ["a.py"]);
    expect(p.steps).toEqual([]);
    expect(describeProgress(p)).toBe("");
  });

  it("shows no progress when nothing has changed yet", () => {
    const p = planProgress(plan(steps), []);
    expect(p.done).toBe(0);
    expect(p.steps.every((s) => s.state !== "done")).toBe(true);
  });
});
