/**
 * Assembling a turn for review.
 *
 * Joins the two halves built before this: `turns.ts` cuts the transcript into
 * turns, `snapshots.ts` + `changeset.ts` say what moved on disk. This puts them
 * together and hands the renderer one object.
 *
 * The honest shape of the problem: fove can only bound a turn it was watching.
 * A turn that ran before the workspace opened has no opening snapshot, and a
 * change set built against `now` would attribute every uncommitted edit in the
 * tree to it. So this reports **what it knows and what it does not**, and the
 * overlay says so rather than showing a confident list built on nothing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTranscript } from "../data/transcript.js";
import { splitTurns, latestTurn, looksFinished, type Turn, type TurnRecord } from "../shared/turns.js";
import { compareSnapshots, summarise, confidence, type ChangeSet } from "../shared/changeset.js";
import { SnapshotStore, takeSnapshot } from "./snapshots.js";
import type { ClaudeSessionService } from "./claudeSession.js";

const execFileP = promisify(execFile);
import { fileContract, type FileContract } from "./contract.js";
import { byAttention, type WorklistFile, type Tone } from "../shared/worklist.js";
import { findInterpreters } from "./interpreters.js";

/** Why a turn has no change set. Each one means something different. */
export type UnboundedReason =
  /** No snapshot was taken when this turn began -- fove was not watching. */
  | "not-watching"
  /** The workspace is not a git repository. */
  | "not-a-repo"
  /** The turn is still running; there is nothing final to compare against. */
  | "running";

export interface TurnReview {
  turn: Turn | null;
  /** Every turn in the session, newest first, for navigating history. */
  history: { id: string; prompt: string; startedAt: number; endedAt?: number }[];
  changes: ChangeSet | null;
  /** Present only when `changes` is null. */
  unbounded?: UnboundedReason;
  summary: string;
  /** How much of the change set is muddied by work already in flight. */
  confidence: ReturnType<typeof confidence> | null;
  /** True while the turn is still producing records. */
  running: boolean;
  /**
   * False when the turn came from the workspace's newest session rather than
   * the focused pane's own -- worth saying, since it may not be the session
   * being looked at.
   */
  fromPane: boolean;
}

/**
 * Reads a session and pairs its newest turn with what changed on disk.
 *
 * Snapshot lifecycle is deliberately simple: `begin` is called when a workspace
 * opens and after each review is taken, so there is always an open snapshot to
 * compare against. That means a boundary is only as good as the last time
 * anything asked -- stated in the type rather than hidden, via `unbounded`.
 */
export class KeelService {
  private readonly snapshots = new SnapshotStore();
  /** Resolved once: probing interpreters costs a process start each. */
  private pythonPromise: Promise<string | undefined> | null = null;

  constructor(private readonly sessions: ClaudeSessionService) {}

  /** Start watching a worktree, or re-arm after a review. */
  async begin(cwd: string): Promise<{ watching: boolean }> {
    const snap = await this.snapshots.begin(cwd);
    return { watching: snap !== null };
  }

  forget(cwd: string): void {
    this.snapshots.forget(cwd);
  }

  /**
   * The newest turn, with whatever can honestly be said about what it changed.
   *
   * `shellPid` names the pane whose session to read. Without it the newest
   * transcript in the directory is used, which is only correct when a single
   * session is open -- with an editor and a fove pane both running, "newest" is
   * whichever was typed in last.
   */
  async review(cwd: string, shellPid?: number): Promise<TurnReview> {
    const { turns, fromPane } = await this.readTurns(cwd, shellPid);
    const turn = latestTurn(turns);

    const history = turns
      .slice()
      .reverse()
      .slice(0, 50)
      .map((t) => ({ id: t.id, prompt: t.prompt, startedAt: t.startedAt, endedAt: t.endedAt }));

    const running = turn ? !looksFinished(turn, Date.now()) : false;

    const opening = this.snapshots.opening(cwd);
    if (!opening) {
      // Distinguish "not a repo" from "was not watching": the first is a
      // permanent property of the workspace, the second is fixable by opening
      // Keel earlier, and telling the user the wrong one wastes their time.
      const probe = await takeSnapshot(cwd);
      return {
        turn,
        history,
        changes: null,
        unbounded: probe === null ? "not-a-repo" : "not-watching",
        summary: probe === null ? "not a git repository" : "no boundary for this turn",
        confidence: null,
        running,
        fromPane,
      };
    }

    const after = await takeSnapshot(cwd);
    if (!after) {
      return {
        turn, history, changes: null, unbounded: "not-a-repo",
        summary: "not a git repository", confidence: null, running, fromPane,
      };
    }

    const changes = compareSnapshots(opening, after);
    return {
      turn,
      history,
      changes,
      summary: summarise(changes),
      confidence: confidence(changes),
      running,
      fromPane,
    };
  }

  /**
   * The workspace's files, ranked by attention.
   *
   * Tone comes from what is actually known today: git says what is dirty and
   * what the current turn touched, and the snapshot store says which of those
   * moved inside the window. The handoff's `failing` and `drifted` tones need
   * intents and telemetry, so nothing is given those tones yet -- an empty
   * category is honest, a fabricated one is not.
   */
  async worklist(cwd: string): Promise<Worklist> {
    const now = await takeSnapshot(cwd);
    if (!now) return { files: [], total: 0, changedCount: 0, fromHistory: 0 };

    const opening = this.snapshots.opening(cwd);
    const changedInTurn = new Set<string>();
    if (opening) {
      for (const c of compareSnapshots(opening, now).changed) changedInTurn.add(c.path);
    }

    const files: WorklistFile[] = now.files.map((f) => {
      // "changed" is reserved for movement inside the turn window; a file that
      // was already dirty when the turn began is dirty, not this turn's work.
      const tone: Tone = changedInTurn.has(f.path) ? "changed" : "normal";
      return {
        path: f.path,
        tone,
        badge: changedInTurn.has(f.path) ? "this turn" : f.status,
        touchedAt: changedInTurn.has(f.path) ? now.takenAt : undefined,
      };
    });

    /*
     * The last commit's files, and only when nothing is uncommitted.
     *
     * This column answers "what is this turn's work", so borrowed history is a
     * fallback for one case: a clean tree, where the work you just finished is
     * the commit you just made.
     *
     * The first version asked for 15 commits by anyone, which on a shared
     * repository is not a fallback but a firehose -- measured on `core`: 60
     * rows, 0 of them changed, every one from nine other people's merges,
     * presented as your worklist. One commit, and only when there is nothing
     * else to show, is the most that can honestly be called your work.
     */
    const fromHistory = files.length === 0 ? await this.lastCommitFiles(cwd) : [];
    for (const path of fromHistory) {
      files.push({ path, tone: "normal", badge: "last commit" });
    }

    return {
      files: byAttention(files),
      total: files.length,
      // The renderer must not describe borrowed history as this turn's work.
      changedCount: changedInTurn.size,
      fromHistory: fromHistory.length,
    };
  }

  /**
   * Paths in the most recent commit, newest first.
   *
   * One commit, not a handful: this is the "you just committed and the tree is
   * clean" case, and the commit you just made is the only history that can
   * honestly be called the work you were doing. Anything further back is a
   * changelog, and on a shared repository it is mostly other people's.
   *
   * Capped, because a merge or a formatting sweep can touch hundreds of files
   * and this is a worklist column, not a file browser.
   */
  private async lastCommitFiles(cwd: string, cap = 20): Promise<string[]> {
    try {
      const { stdout } = await execFileP(
        "git",
        ["log", "-1", "--name-only", "--format=", "--diff-filter=d"],
        { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      const out: string[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split("\n")) {
        const p = line.trim();
        if (!p || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        if (out.length >= cap) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * A file card: its contract, and where its purpose comes from.
   *
   * Rule 2 of the handoff -- generated, never authored. Purpose is inferred and
   * *labelled* as inferred until intents exist, because the design's own
   * "no intent" state is the honest default here rather than an edge case.
   */
  async card(cwd: string, path: string): Promise<{
    contract: FileContract;
    purpose: string;
    purposeInferred: boolean;
  }> {
    const python = await this.python();
    const full = path.startsWith("/") ? path : `${cwd}/${path}`;
    const contract = await fileContract(full, python);

    // The best available purpose: the first docstring on the surface. Not a
    // summary of the file, and the UI says so.
    const documented = contract.entries.find((e) => e.summary);
    const purpose = documented?.summary
      ?? (contract.entries.length > 0
        ? `Exports ${contract.entries.length} name${contract.entries.length === 1 ? "" : "s"}. No description in the source.`
        : "No exported surface and no description.");

    return { contract, purpose, purposeInferred: true };
  }

  /** The interpreter to extract Python contracts with, resolved once. */
  private python(): Promise<string | undefined> {
    this.pythonPromise ??= findInterpreters(process.cwd())
      .then((list) => list.find((i) => i.version)?.path)
      .catch(() => undefined);
    return this.pythonPromise;
  }

  /**
   * Turn records for a session, or an empty list when none can be read.
   *
   * Prefers the named pane's own session, then falls back to the workspace's
   * newest transcript. The fallback matters: a pane running a *fresh* Claude
   * session has zero turns, and reporting "no turns" while a session with 153
   * of them sits in the same workspace is true and useless. The caller is told
   * which source was used so the UI can say so.
   */
  private async readTurns(
    cwd: string,
    shellPid?: number,
  ): Promise<{ turns: Turn[]; fromPane: boolean }> {
    let summary = shellPid ? await this.sessions.forPane(cwd, shellPid) : null;
    let fromPane = summary !== null;
    if (!summary) summary = await this.sessions.newestFor(cwd);
    if (!summary) return { turns: [], fromPane: false };

    const records: TurnRecord[] = [];
    try {
      for await (const rec of readTranscript(summary.path)) {
        records.push(rec as TurnRecord);
      }
    } catch {
      // A transcript being written while read can end mid-line. Whatever was
      // read is still usable, so this returns what it has rather than nothing.
    }
    const turns = splitTurns(records);
    // A pane whose own session has produced nothing yet is not worth showing
    // over a workspace that has real history.
    if (fromPane && turns.length === 0) {
      const newest = await this.sessions.newestFor(cwd);
      if (newest && newest.path !== summary.path) {
        return { turns: await this.readPath(newest.path), fromPane: false };
      }
    }
    return { turns, fromPane };
  }

  /** Read and split one transcript by path. */
  private async readPath(path: string): Promise<Turn[]> {
    const records: TurnRecord[] = [];
    try {
      for await (const rec of readTranscript(path)) records.push(rec as TurnRecord);
    } catch {
      // Partial read is still usable.
    }
    return splitTurns(records);
  }
}

/** A workspace's files, ranked by attention. See `worklist.ts` for the order. */
export interface Worklist {
  files: WorklistFile[];
  /** Total files considered, so the header can say "4 of 312". */
  total: number;
  /**
   * How many files actually moved during the turn window.
   *
   * Distinct from `total`, and the distinction is the point: on a clean tree
   * every row is borrowed from the last commit, and describing those as this
   * turn's work is a lie the UI would tell confidently.
   */
  changedCount: number;
  /** How many rows came from the last commit rather than the working tree. */
  fromHistory: number;
}
