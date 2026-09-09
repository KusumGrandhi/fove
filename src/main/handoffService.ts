/**
 * Running the handoff loop, per workspace.
 *
 * `shared/handoff.ts` is the state machine and `handoffRunner.ts` drives
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
import { HandoffRunner } from "./handoffRunner.js";
import { IntentStore } from "./intentStore.js";
import { SnapshotStore, takeSnapshot } from "./snapshots.js";
import { compareSnapshots } from "../shared/changeset.js";

export class HandoffService extends EventEmitter {
  private readonly runner = new HandoffRunner();
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

    const r = await this.runner.plan(ticket, forPrompt, {
      cwd, budgetUSD, signal: abort.signal,
    });

    if (!r.plan) {
      this.apply(cwd, { type: "failed", reason: r.error ?? "planning produced no plan" });
      return;
    }
    this.apply(cwd, {
      type: "planned", plan: r.plan, sessionId: r.sessionId, costUSD: r.costUSD,
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
    this.startWatching(cwd);

    const exec = await this.runner.execute(approved.plan, {
      cwd,
      budgetUSD: approved.budgetUSD,
      sessionId: approved.sessionId,
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

    let checks: CheckResult[] = [];
    try {
      const r = await this.runner.check(
        changed,
        mechanisms,
        (command) => this.intents.runMechanism(cwd, command),
        { cwd, budgetUSD: state.budgetUSD, sessionId: state.sessionId, signal: abort.signal },
      );
      checks = r.checks;
    } catch {
      // A failed review must not lose the work. Reaching `ready` with no
      // checks is honest -- and the UI says nothing checked it.
      checks = [];
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
    const r = await this.runner.plan(
      `${state.ticket}\n\nThe previous plan was not accepted. ${note}`,
      stored.intents.map((i) => ({
        id: i.id, headline: i.headline,
        clauses: i.clauses.map((c) => ({ name: c.name, text: c.text })),
      })),
      { cwd, budgetUSD: state.budgetUSD, sessionId: state.sessionId, signal: abort.signal },
    );

    if (!r.plan) {
      this.apply(cwd, { type: "failed", reason: r.error ?? "replanning produced no plan" });
      return;
    }
    this.apply(cwd, { type: "replan", plan: r.plan, costUSD: r.costUSD });
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
    this.states.delete(cwd);
    this.snapshots.forget(cwd);
    this.emit("changed", cwd, initial());
  }
}
