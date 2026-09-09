/**
 * Running the handoff loop, per workspace.
 *
 * `shared/handoff.ts` is the state machine and `phases.ts` drives
 * `claude`; this owns the running loop -- one per workspace, its state pushed
 * to the renderer as it changes.
 *
 * The phases advance on their own except at the gate. Planning runs, then it
 * **stops** and waits for a human; nothing resumes it but an approval. That is
 * the only place the loop blocks, and it blocks there deliberately.
 *
 * State lives in memory. A loop is tied to the `claude` processes it spawned,
 * and restoring one from disk would mean resuming a conversation whose
 * execution already stopped -- a half-finished handoff that looks live.
 */

import { EventEmitter } from "node:events";
import {
  initial, reduce, mayExecute,
  type HandoffState, type HandoffEvent, type CheckResult,
} from "../shared/handoff.js";
import * as phases from "./phases.js";
import type { DriftViolation } from "./phases.js";
import { makeRunDir } from "./agentRunner.js";
import { installAgents } from "./agentFiles.js";
import { IntentStore } from "./intentStore.js";
import { SnapshotStore, takeSnapshot } from "./snapshots.js";
import { compareSnapshots } from "../shared/changeset.js";

export class HandoffService extends EventEmitter {
  /** Where each workspace's current run keeps its artifacts. */
  private readonly runDirs = new Map<string, string>();
  private readonly states = new Map<string, HandoffState>();
  /** Abort handles, so a stop actually kills the child process. */
  private readonly aborts = new Map<string, AbortController>();
  /** Where the tree stood when execution began, for the change set. */
  private readonly snapshots = new SnapshotStore();
  /** Live per-cwd polling of what has moved, while a phase is executing. */
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Workspaces asked to stop at the next phase boundary.
   *
   * Deliberately *not* "pause after this step". Execution is a single `claude`
   * invocation for the whole plan, so there is no step boundary to stop on --
   * a button promising one would be a lie about how the loop works. The real
   * boundary is between phases, and stopping there means the work is finished
   * and on disk but nothing has reviewed it yet, which is a genuine place to
   * take over.
   */
  private readonly pauseRequested = new Set<string>();

  /** Ask the loop to stop after the running phase, without killing it. */
  requestPause(cwd: string, want: boolean): void {
    if (want) this.pauseRequested.add(cwd);
    else this.pauseRequested.delete(cwd);
    this.emit("changed", cwd, this.state(cwd));
  }

  isPauseRequested(cwd: string): boolean {
    return this.pauseRequested.has(cwd);
  }
  /** Paths seen to have moved so far this execution, for step status. */
  private readonly progress = new Map<string, string[]>();
  /** Intent violations the discriminator found, per workspace. */
  private readonly drifted = new Map<string, DriftViolation[]>();

  /** Which intents the last check found the work contradicting. */
  driftedIntents(cwd: string): DriftViolation[] {
    return this.drifted.get(cwd) ?? [];
  }

  /** What has changed so far in the running execution, for the UI. */
  changedSoFar(cwd: string): string[] {
    return this.progress.get(cwd) ?? [];
  }

  /**
   * Poll the tree while the agent works, so the plan can show its status.
   *
   * Polling rather than a filesystem watcher: the comparison is against the
   * opening snapshot, which is a whole-tree hash read anyway, and a watcher
   * would fire on every intermediate write an editor makes. Four seconds is
   * slow enough to cost nothing and fast enough that a step lights up while
   * you are still looking at it.
   */
  private startWatching(cwd: string): void {
    this.stopWatching(cwd);
    const tick = async (): Promise<void> => {
      const opening = this.snapshots.opening(cwd);
      if (!opening) return;
      const now = await takeSnapshot(cwd);
      if (!now) return;
      const changed = compareSnapshots(opening, now).changed.map((c) => c.path);
      const prev = this.progress.get(cwd) ?? [];
      // Only wake the renderer when the set actually moved.
      if (prev.length !== changed.length || prev.some((p, i) => p !== changed[i])) {
        this.progress.set(cwd, changed);
        this.emit("changed", cwd, this.state(cwd));
      }
    };
    this.watchers.set(cwd, setInterval(() => void tick(), 4000));
  }

  private stopWatching(cwd: string): void {
    const t = this.watchers.get(cwd);
    if (t) { clearInterval(t); this.watchers.delete(cwd); }
  }

  constructor(private readonly intents: IntentStore) {
    super();
  }

  state(cwd: string): HandoffState {
    return this.states.get(cwd) ?? initial();
  }

  /** Apply an event and tell the renderer. */
  private apply(cwd: string, event: HandoffEvent): HandoffState {
    const next = reduce(this.state(cwd), event);
    this.states.set(cwd, next);
    this.emit("changed", cwd, next);
    return next;
  }

  /**
   * Hand over a ticket.
   *
   * Plans and then stops. Execution needs an approval, which is the whole
   * point of the gate -- so this returns as soon as there is a plan to look at.
   */
  async start(cwd: string, ticket: string, budgetUSD: number): Promise<void> {
    if (this.state(cwd).phase === "planning") return;

    this.apply(cwd, { type: "start", ticket, budgetUSD });

    const abort = new AbortController();
    this.aborts.set(cwd, abort);

    // The agent plans against the rules it will be held to. Sending them at
    // plan time rather than at review time is the difference between a plan
    // that avoids breaking one and a review that discovers it did.
    const stored = await this.intents.load(cwd);
    const forPrompt = stored.intents.map((i) => ({
      id: i.id,
      headline: i.headline,
      clauses: i.clauses.map((c) => ({ name: c.name, text: c.text })),
    }));

    // The agent definitions must exist before an agent can be named. Never
    // overwrites: once you have edited one it is yours.
    await installAgents(cwd);
    const runDir = await makeRunDir(cwd);
    this.runDirs.set(cwd, runDir);

    const r = await phases.plan(ticket, forPrompt, {
      cwd, runDir, budgetUSD, signal: abort.signal,
    });

    if (!r.output) {
      this.apply(cwd, { type: "failed", reason: r.error ?? "planning produced no plan" });
      return;
    }
    this.apply(cwd, {
      type: "planned", plan: r.output, sessionId: r.sessionId, costUSD: r.costUSD,
    });
  }

  /**
   * Approve the plan and run the rest: execute, then check, then ready.
   *
   * Everything after the gate is automatic. The next time a human is needed is
   * the review itself, which is where the loop is designed to end.
   */
  async approve(cwd: string): Promise<void> {
    const approved = this.apply(cwd, { type: "approve" });
    if (!mayExecute(approved) || !approved.plan) return;

    const abort = new AbortController();
    this.aborts.set(cwd, abort);

    // Snapshot before any edit, so the change set is the turn's work rather
    // than everything uncommitted.
    await this.snapshots.begin(cwd);
    // From here the tree is the record of what the agent is doing, so the
    // plan's steps can report their own status while it works.
    this.progress.set(cwd, []);
    // Last run's verdict is about last run's diff; keeping it would attach a
    // stale violation to work that has not been judged yet.
    this.drifted.delete(cwd);
    this.startWatching(cwd);

    const runDir = this.runDirs.get(cwd) ?? await makeRunDir(cwd);
    this.runDirs.set(cwd, runDir);

    const exec = await phases.execute(approved.ticket, approved.plan, {
      cwd, runDir,
      budgetUSD: approved.budgetUSD,
      signal: abort.signal,
    });

    this.stopWatching(cwd);

    if (!exec.ok) {
      this.apply(cwd, { type: "failed", reason: exec.error ?? "execution failed" });
      return;
    }
    const executed = this.apply(cwd, { type: "executed", costUSD: exec.costUSD });
    if (executed.phase !== "checking") return;

    /*
     * Stop here if asked, with the work done and unreviewed.
     *
     * `stop` rather than a new phase: the state machine already means
     * "finished early, and a human owns what happens next", and the reason
     * says the changes are on disk so nobody has to guess.
     */
    if (this.pauseRequested.has(cwd)) {
      this.pauseRequested.delete(cwd);
      this.apply(cwd, {
        type: "stop",
        reason: "paused after execution — the changes are on disk, nothing has checked them",
      });
      return;
    }

    await this.check(cwd, executed);
  }

  /** Run mechanisms and an adversarial review over what changed. */
  private async check(cwd: string, state: HandoffState): Promise<void> {
    const pair = await this.snapshots.end(cwd);
    const changed = pair
      ? compareSnapshots(pair.before, pair.after).changed.map((c) => c.path)
      : [];

    const stored = await this.intents.load(cwd);
    const mechanisms = stored.intents.flatMap((i) =>
      i.clauses
        .filter((c) => c.mechanism)
        .map((c) => ({ label: `${i.headline} — ${c.name}`, command: c.mechanism! })),
    );

    const abort = this.aborts.get(cwd) ?? new AbortController();

    const runDir = this.runDirs.get(cwd) ?? await makeRunDir(cwd);
    this.runDirs.set(cwd, runDir);

    /*
     * Mechanisms first, and separately from the review.
     *
     * A mechanism is a search: it gives a verdict that does not depend on
     * anyone's judgment. The review is a judgment. They are never merged into
     * a single "looks good", and the UI labels them differently for the same
     * reason.
     */
    const checks: CheckResult[] = [];
    for (const m of mechanisms) {
      const r = await this.intents.runMechanism(cwd, m.command);
      checks.push({
        kind: "mechanism",
        label: m.label,
        passed: r.passed,
        detail: r.passed ? undefined : r.output.slice(0, 400),
      });
    }

    try {
      const r = await phases.review(changed, {
        cwd, runDir, budgetUSD: state.budgetUSD, signal: abort.signal,
      });
      checks.push(...r.checks);
    } catch {
      // A failed review must not lose the work. Reaching `ready` with no
      // checks is honest -- and the UI says nothing checked it.
    }

    /*
     * The discriminator: a second agent reads the diff against the rules.
     *
     * Separate from the review above, and after it, because they answer
     * different questions -- that one asks "is this change any good", this one
     * asks "does it break a rule you wrote down". Its failure is contained:
     * drift is an addition to what is known, so if it cannot run, the rest of
     * the checks still stand.
     */
    try {
      const forReview = stored.intents.map((i) => ({
        id: i.id,
        headline: i.headline,
        clauses: i.clauses.map((c) => ({ num: c.num, name: c.name, text: c.text })),
      }));
      const d = await phases.drift(forReview, {
        cwd, runDir, budgetUSD: state.budgetUSD, signal: abort.signal,
      });

      this.drifted.set(cwd, d.violations);
      for (const v of d.violations) {
        const intent = stored.intents.find((i) => i.id === v.intentId);
        const clause = intent?.clauses.find((c) => c.num === v.clause);
        checks.push({
          kind: "intent",
          label: `${intent?.headline ?? v.intentId} — ${clause?.name ?? v.clause}`,
          passed: false,
          // The evidence is the point: a drift claim nobody can check costs
          // more to verify than it saves.
          detail: `${v.file}: ${v.evidence}`
            + (v.confident === false ? " (reviewer was not certain)" : ""),
        });
      }
    } catch {
      // Drift is an addition to what is known; failing to compute it must not
      // discard the checks that did run.
    }

    this.apply(cwd, { type: "checked", checks });
  }

  /** Replace the plan and go back to the gate. */
  async replan(cwd: string, note: string): Promise<void> {
    const state = this.state(cwd);
    if (!state.plan) return;

    const abort = new AbortController();
    this.aborts.set(cwd, abort);

    const stored = await this.intents.load(cwd);
    // A fresh run directory: the rejected plan stays on disk under the old
    // one, so what was turned down is still readable afterwards.
    const runDir = await makeRunDir(cwd);
    this.runDirs.set(cwd, runDir);

    const r = await phases.plan(
      `${state.ticket}\n\nThe previous plan was not accepted. ${note}`,
      stored.intents.map((i) => ({
        id: i.id, headline: i.headline,
        clauses: i.clauses.map((c) => ({ name: c.name, text: c.text })),
      })),
      { cwd, runDir, budgetUSD: state.budgetUSD, signal: abort.signal },
    );

    if (!r.output) {
      this.apply(cwd, { type: "failed", reason: r.error ?? "replanning produced no plan" });
      return;
    }
    this.apply(cwd, { type: "replan", plan: r.output, costUSD: r.costUSD });
  }

  /** Stop the loop and kill whatever it spawned. */
  stop(cwd: string, reason = "you stopped it"): void {
    this.aborts.get(cwd)?.abort();
    this.aborts.delete(cwd);
    this.stopWatching(cwd);
    this.apply(cwd, { type: "stop", reason });
  }

  /** Clear a finished loop so the pane can take another ticket. */
  reset(cwd: string): void {
    this.aborts.get(cwd)?.abort();
    this.aborts.delete(cwd);
    this.stopWatching(cwd);
    this.progress.delete(cwd);
    this.pauseRequested.delete(cwd);
    this.drifted.delete(cwd);
    this.states.delete(cwd);
    this.snapshots.forget(cwd);
    this.emit("changed", cwd, initial());
  }
}
