/**
 * Keel — review and approve, built to the `2c` specification.
 *
 * An overlay, not a mode and not a replacement for the panes. ⌘L opens it,
 * Escape closes it, and everything underneath keeps running: no pane unmounts,
 * no PTY dies, the agent does not pause. If the summary cannot tell you enough
 * you close it and read the code, which is why it does not have to be complete
 * enough to live in.
 *
 * Layered at z-index 50, below the command palette and below Claude's blocking
 * diff (both 60), so an approval Claude is waiting on always wins.
 *
 * **Structure is the handoff's, verbatim where the data allows:** 872px card,
 * two summary boxes side by side, one row per file with a two-column was /
 * is-now grid, then an action row. Its own typefaces and palette rather than
 * fove's, for the same reason -- an earlier attempt substituted fove's tokens
 * and lost the design.
 *
 * **Where it degrades, it says so.** The handoff's `WAS` and `IS NOW` columns
 * hold an extracted type surface. Python at 39% return-annotation cannot give
 * us one, so those columns hold what git knows -- the file's prior state and
 * its current one -- and the screen labels that rather than dressing a diff in
 * the language of contracts.
 *
 * **It never claims authorship.** "Changed during this turn", never "the agent
 * did this"; a test in `changeset.test.ts` pins the same rule on the data.
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeSet, ChangeKind, FileChange } from "../../shared/changeset.js";
import { SURFACE, BORDER, INK, BRAND, STATE, FONT, TYPE, RADIUS, SHADOW, cleanPrompt } from "./keel-tokens.js";

interface TurnLite {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
}

export interface TurnReview {
  turn: TurnLite | null;
  history: TurnLite[];
  changes: ChangeSet | null;
  unbounded?: "not-watching" | "not-a-repo" | "running";
  summary: string;
  confidence: { clean: number; muddied: number; reliable: boolean } | null;
  running: boolean;
  fromPane: boolean;
}

/** State colour per kind of change, matching the risk ordering. */
const KIND_COLOR: Record<ChangeKind, string> = {
  added: STATE.good,
  resolved: STATE.bad,
  modified: STATE.warn,
  unchanged: INK.i5,
};

/** What each kind was, and is now — the two columns of the handoff's grid. */
const KIND_STATES: Record<ChangeKind, { was: string; now: string }> = {
  added: { was: "not in the working tree", now: "new, uncommitted" },
  modified: { was: "committed, or already edited", now: "edited during this turn" },
  resolved: { was: "uncommitted changes", now: "reverted, committed, or deleted" },
  unchanged: { was: "uncommitted changes", now: "unchanged" },
};

/** One sentence of consequence, saffron when it is the risky one. */
function consequence(f: FileChange): { text: string; risky: boolean } {
  if (f.kind === "resolved") {
    return {
      text: "Work that was here is gone. If that was not intended, it is not in the working tree any more.",
      risky: true,
    };
  }
  if (f.kind === "added") {
    return { text: "A file that did not exist before this turn. Nothing has reviewed it.", risky: false };
  }
  if (f.preexisting) {
    return {
      text: "Already had uncommitted changes before the turn, so what the turn did cannot be separated from what was there.",
      risky: true,
    };
  }
  return { text: "Was clean at the start of the turn, so this change belongs to it.", risky: false };
}

const rel = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const dur = (t: TurnLite): string => {
  if (t.endedAt === undefined) return "running";
  const s = Math.round((t.endedAt - t.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function Keel(props: {
  review: TurnReview | null;
  loading: boolean;
  cwd: string;
  onClose: () => void;
  onOpenFile: (path: string, line?: number) => void;
  onRefresh: () => void;
}) {
  const { review } = props;
  const hostRef = useRef<HTMLDivElement>(null);

  // Escape closes. Captured, because a pane underneath may also listen and the
  // overlay is the thing in front.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);

  useEffect(() => { hostRef.current?.focus(); }, []);

  const changed = review?.changes?.changed ?? [];
  const carried = review?.changes?.carried ?? [];

  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [composing, setComposing] = useState(false);
  /** Paths currently in the index, so a card can show itself as accepted. */
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);

  /**
   * Read which files are staged, from git rather than from memory.
   *
   * The index is shared: the git pane stages, the terminal stages, and a
   * `claude` session in a pane can stage too. Keeping a local guess would let
   * this screen disagree with the repository about what you have accepted.
   */
  const readStaged = async (): Promise<void> => {
    try {
      const s = await window.th.gitStatus(props.cwd) as
        { files?: { path: string; staged: string | null }[] } | undefined;
      setStaged(new Set((s?.files ?? []).filter((f) => f.staged !== null).map((f) => f.path)));
    } catch {
      // A status read failing is not worth a message; the cards simply do not
      // claim anything is accepted.
      setStaged(new Set());
    }
  };

  useEffect(() => { void readStaged(); }, [props.cwd, review]);

  /** Accept one file, or take the acceptance back. */
  const setFileStaged = async (path: string, want: boolean): Promise<void> => {
    setBusyPath(path);
    setRevertError(null);
    try {
      const r = await (want
        ? window.th.gitStage(props.cwd, [path])
        : window.th.gitUnstage(props.cwd, [path])) as
        { ok?: boolean; stderr?: string } | undefined;
      if (r && r.ok === false) {
        setRevertError(r.stderr?.trim() || `could not ${want ? "stage" : "unstage"} ${path}`);
      }
      await readStaged();
    } catch (e) {
      setRevertError((e as Error).message);
    } finally {
      setBusyPath(null);
    }
  };

  /**
   * Commit this turn's files, and only this turn's.
   *
   * Committing is not merging. The loop ends at *ready to review* because the
   * judgment is yours -- but recording what you just reviewed, on your branch,
   * with nothing pushed, is not that judgment. It is the bookkeeping that
   * follows it, and this screen is where you have the diff in front of you.
   *
   * Staged by explicit path, never `commit -a`: the carried files are work in
   * progress this screen has just told you the turn did not touch, and
   * sweeping them into your commit would make the summary above a lie.
   */
  /** Accept every file this turn touched, still by explicit path. */
  const acceptAll = async (): Promise<void> => {
    const paths = changed.map((f) => f.path).filter((p) => !staged.has(p));
    if (paths.length === 0) return;
    setBusyPath("*");
    setRevertError(null);
    try {
      const r = await window.th.gitStage(props.cwd, paths) as
        { ok?: boolean; stderr?: string } | undefined;
      if (r && r.ok === false) {
        setRevertError(r.stderr?.trim() || "could not stage those files");
      }
      await readStaged();
    } catch (e) {
      setRevertError((e as Error).message);
    } finally {
      setBusyPath(null);
    }
  };

  /** This turn's files that you have accepted. The commit is exactly these. */
  const accepted = changed.filter((f) => staged.has(f.path));

  const commit = async (): Promise<void> => {
    if (accepted.length === 0 || !commitMsg.trim()) return;

    setCommitting(true);
    setRevertError(null);
    try {
      /*
       * Staged again by explicit path, immediately before committing.
       *
       * The cards already staged them, but a file can be edited after being
       * accepted -- by you, or by an agent still running in a pane underneath.
       * Re-staging means the commit contains what the card showed rather than
       * a half-old index entry.
       */
      const s = await window.th.gitStage(props.cwd, accepted.map((f) => f.path)) as
        { ok?: boolean; stderr?: string } | undefined;
      if (s && s.ok === false) {
        setRevertError(s.stderr?.trim() || "could not stage those files");
        return;
      }
      const r = await window.th.gitCommit(props.cwd, commitMsg.trim()) as
        { ok?: boolean; stderr?: string; stdout?: string } | undefined;
      if (r && r.ok === false) {
        // A failing pre-commit hook lands here, and its output is the useful
        // part -- so it is shown verbatim rather than summarised.
        setRevertError((r.stderr || r.stdout || "").trim() || "commit failed");
        return;
      }
      setCommitMsg("");
      setComposing(false);
      await readStaged();
      props.onRefresh();
    } catch (e) {
      setRevertError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  /**
   * Undo this turn's work, and only this turn's.
   *
   * The path list comes from `changed`, never from git status: a file that was
   * already dirty when the turn began is someone else's work in progress, and
   * discarding it here would destroy edits this screen explicitly says the
   * turn did not make.
   *
   * Confirmed first, because it is not undoable by anything fove offers.
   */
  const revert = async (): Promise<void> => {
    const paths = changed.map((f) => f.path);
    if (paths.length === 0) return;
    const ok = window.confirm(
      `Discard changes to ${paths.length} file${paths.length === 1 ? "" : "s"}?\n\n`
      + paths.slice(0, 12).join("\n")
      + (paths.length > 12 ? `\n…and ${paths.length - 12} more` : "")
      + "\n\nThis cannot be undone.",
    );
    if (!ok) return;

    setReverting(true);
    setRevertError(null);
    try {
      const r = await window.th.gitDiscard(props.cwd, paths) as
        { ok?: boolean; stderr?: string } | undefined;
      if (r && r.ok === false) {
        setRevertError(r.stderr?.trim() || "git could not discard those files");
      } else {
        props.onRefresh();
      }
    } catch (e) {
      setRevertError((e as Error).message);
    } finally {
      setReverting(false);
    }
  };

  return (
    <div style={S.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div style={S.card} ref={hostRef} tabIndex={-1}>

        {/* --- top bar: what this turn was, and how big --- */}
        <header style={S.topbar}>
          <span style={S.claimId}>THIS TURN</span>
          <span style={S.claimTitle}>
            {review?.turn ? cleanPrompt(review.turn.prompt).split("\n")[0]!.slice(0, 64) : "no turn yet"}
          </span>
          <span style={{ flex: 1 }} />
          {review?.running && (
            <span style={S.runPill}><span style={S.dot} />running</span>
          )}
          <span style={S.count}>
            {changed.length} file{changed.length === 1 ? "" : "s"}
            {carried.length > 0 && ` · ${carried.length} carried`}
          </span>
          <button style={S.ghost} onClick={props.onRefresh}>refresh</button>
          <button style={S.ghost} onClick={props.onClose}>close <span style={S.kbd}>esc</span></button>
        </header>

        {props.loading && !review ? (
          <div style={S.empty}>reading the session…</div>
        ) : !review?.turn ? (
          <div style={S.empty}>
            <div style={{ ...TYPE.body135, color: INK.i2, marginBottom: 8 }}>
              No turns in this workspace yet.
            </div>
            <div style={{ ...TYPE.body115, color: INK.i4, maxWidth: 420, margin: "0 auto" }}>
              Keel opens on the last thing you asked Claude to do.
            </div>
          </div>
        ) : (
          <div style={S.body}>

            {/* --- the ask --- */}
            <section>
              <div style={S.eyebrow}>THE ASK</div>
              <p style={S.ask}>{cleanPrompt(review.turn.prompt)}</p>
              <div style={S.askMeta}>
                {!review.fromPane && (
                  <span style={S.chip} title="the focused pane has no turns of its own yet">
                    newest session
                  </span>
                )}
                <span>{rel(review.turn.startedAt)}</span>
                <span>·</span>
                <span>{dur(review.turn)}</span>
              </div>
            </section>

            {/* --- two summary boxes, side by side --- */}
            <div style={S.summaryRow}>
              <div style={S.summaryNeutral}>
                <div style={{ ...S.eyebrow, color: INK.i5, marginBottom: 7 }}>
                  WHAT IS KNOWN
                </div>
                <div style={{ ...TYPE.body125, color: INK.i2 }}>
                  {review.changes === null
                    ? "No boundary for this turn, so nothing can be attributed to it."
                    : `${changed.length} file${changed.length === 1 ? "" : "s"} moved between the start of this turn and now.`}
                </div>
              </div>

              {/*
                * The important box. The handoff calls this "cannot be proven
                * here" and says it isolates what only a human can decide --
                * capped at three items, because more than three means the task
                * was scoped too widely.
                */}
              <div style={S.summaryWarn}>
                <div style={{ ...S.eyebrow, color: STATE.warn, marginBottom: 7 }}>
                  CANNOT BE PROVEN HERE
                </div>
                <div style={{ ...TYPE.body125, color: INK.i2 }}>
                  {unproven(review).slice(0, 3).map((line, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>{line}</div>
                  ))}
                </div>
              </div>
            </div>

            {/* --- file by file --- */}
            {review.changes === null ? (
              <Unbounded reason={review.unbounded} />
            ) : (
              <>
                <div style={S.eyebrow}>
                  FILE BY FILE — WHAT IT WAS, WHAT IT IS NOW
                </div>

                {changed.length === 0 ? (
                  <div style={{ ...TYPE.body125, color: INK.i4 }}>Nothing moved on disk.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {changed.map((f) => (
                      <FileCard
                        key={f.path}
                        file={f}
                        staged={staged.has(f.path)}
                        busy={busyPath === f.path}
                        onStage={() => void setFileStaged(f.path, true)}
                        onUnstage={() => void setFileStaged(f.path, false)}
                        onOpen={() => props.onOpenFile(`${props.cwd}/${f.path}`)}
                      />
                    ))}
                  </div>
                )}

                {carried.length > 0 && (
                  <section>
                    <div style={S.eyebrow}>ALREADY DIRTY, UNTOUCHED BY THIS TURN</div>
                    <div style={S.carriedList}>
                      {carried.map((f) => (
                        <span key={f.path} style={S.carriedItem}>{f.path}</span>
                      ))}
                    </div>
                  </section>
                )}

                {/*
                  * --- action row ---
                  *
                  * There is no "accept and merge", and there never will be.
                  * The loop ends at *ready to review*: Keel assembles the
                  * evidence and the judgment stays yours, so a button here
                  * that merges would contradict the one property the whole
                  * design is built on. Accepting means committing, which the
                  * git pane already does with a message you write.
                  *
                  * Revert is offered because undoing a turn you did not want
                  * is the action you need *from this screen*, while you are
                  * looking at what it did.
                  */}
                {changed.length > 0 && (
                  <div style={S.actions}>
                    {composing ? (
                      <div style={S.composer}>
                        <textarea
                          autoFocus
                          style={S.msg}
                          placeholder="What did this turn do, and why?"
                          value={commitMsg}
                          onChange={(e) => setCommitMsg(e.target.value)}
                          // The overlay closes on Escape and Keel's own keys
                          // must not fire while a message is being typed.
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Escape") setComposing(false);
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
                          }}
                        />
                        <div style={S.composerRow}>
                          <button
                            style={S.primary}
                            onClick={() => void commit()}
                            disabled={committing || !commitMsg.trim() || accepted.length === 0}
                          >
                            {committing
                              ? "committing…"
                              : `Commit ${accepted.length} accepted file${accepted.length === 1 ? "" : "s"}`}
                            <span style={S.kbd}>⌘↵</span>
                          </button>
                          <button style={S.secondary} onClick={() => setComposing(false)}>
                            cancel
                          </button>
                          <span style={{ flex: 1 }} />
                          <span style={{ ...TYPE.body115, color: INK.i5 }}>
                            Commits to this branch. Nothing is pushed or merged.
                          </span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/*
                          * Accept-all is a shortcut for the per-file gesture,
                          * not a separate path: it stages the same files the
                          * cards would, so the commit below is always exactly
                          * what is in the index.
                          */}
                        {accepted.length < changed.length && (
                          <button
                            style={S.secondary}
                            onClick={() => void acceptAll()}
                            disabled={busyPath !== null}
                            title={changed.map((f) => f.path).join("\n")}
                          >
                            Accept all {changed.length}
                          </button>
                        )}
                        <button
                          style={{ ...S.primary, opacity: accepted.length === 0 ? 0.45 : 1 }}
                          onClick={() => setComposing(true)}
                          disabled={accepted.length === 0}
                          title={accepted.map((f) => f.path).join("\n")}
                        >
                          {accepted.length === 0
                            ? "Accept a file to commit"
                            : `Commit ${accepted.length} accepted`}
                        </button>
                        <button
                          style={S.secondary}
                          onClick={() => void revert()}
                          disabled={reverting}
                          title={changed.map((f) => f.path).join("\n")}
                        >
                          {reverting
                            ? "reverting…"
                            : `Revert the ${changed.length} file${changed.length === 1 ? "" : "s"} this turn touched`}
                        </button>
                        <span style={{ flex: 1 }} />
                        <span style={{ ...TYPE.body115, color: INK.i5 }}>
                          Files already dirty before the turn are left alone.
                        </span>
                      </>
                    )}
                  </div>
                )}
                {revertError && (
                  <div style={{ ...TYPE.body115, color: STATE.warn }}>{revertError}</div>
                )}
              </>
            )}

            {/* --- earlier turns --- */}
            {review.history.length > 1 && (
              <section>
                <div style={S.eyebrow}>EARLIER TURNS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {review.history.slice(1, 6).map((t) => (
                    <div key={t.id} style={S.histRow} title={cleanPrompt(t.prompt)}>
                      <span style={S.histWhen}>{rel(t.startedAt)}</span>
                      <span style={S.histText}>
                        {cleanPrompt(t.prompt).split("\n")[0]}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What only a human can decide, for the saffron box.
 *
 * Every line here is something the system genuinely cannot check, stated as
 * such. The handoff caps this at three; more than three is itself the signal
 * that the task was too wide.
 */
function unproven(review: TurnReview): string[] {
  const out: string[] = [];
  const changed = review.changes?.changed ?? [];

  if (review.changes === null) {
    out.push("Everything. fove was not watching when this turn began.");
    return out;
  }
  if (review.confidence && !review.confidence.reliable) {
    out.push(
      `${review.confidence.muddied} file${review.confidence.muddied === 1 ? " was" : "s were"} already in flight, so this turn's work cannot be separated from what was there.`,
    );
  }
  if (changed.some((c) => c.kind === "resolved")) {
    out.push("Work disappeared during this turn. Only you know whether that was intended.");
  }
  if (changed.length > 0) {
    out.push(`Whether ${changed.length === 1 ? "this change is" : "these changes are"} correct — nothing checked them against a rule.`);
  }
  if (out.length === 0) out.push("Nothing changed, so there is nothing to judge.");
  return out;
}

/** Why there is no change set. Each reason needs a different response. */
function Unbounded(props: { reason?: "not-watching" | "not-a-repo" | "running" }) {
  const text =
    props.reason === "not-a-repo"
      ? "This workspace is not a git repository, so there is no way to tell what changed."
      : "fove was not watching this workspace when the turn began, so it cannot separate what the turn did from everything else uncommitted. It is watching now — the next turn will have a proper boundary.";
  return (
    <div style={S.summaryWarn}>
      <div style={{ ...S.eyebrow, color: STATE.warn, marginBottom: 7 }}>NO BOUNDARY</div>
      <div style={{ ...TYPE.body125, color: INK.i2 }}>{text}</div>
    </div>
  );
}

/**
 * One file: name and state, the was / is-now grid, then a consequence.
 *
 * The handoff puts an extracted type surface in those two columns. Python at
 * 39% annotation cannot give us one, so they carry what git knows instead --
 * and the eyebrow says "state", not "contract", rather than implying a
 * guarantee that is not there.
 */
function FileCard(props: {
  file: FileChange;
  onOpen: () => void;
  /** Whether this file is already staged, so the row can say "accepted". */
  staged: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
}) {
  const { file } = props;
  const [openDiff, setOpenDiff] = useState(false);
  const states = KIND_STATES[file.kind];
  const cons = consequence(file);

  return (
    <div style={{ ...S.fileCard, borderLeft: `2px solid ${KIND_COLOR[file.kind]}` }}>
      <div style={S.fileHead}>
        <span style={S.filePath}>{file.path}</span>
        <span style={{ ...TYPE.mono105, color: INK.i5 }}>{file.status}</span>
        <span style={{ flex: 1 }} />
        {/*
          * Accepting a file stages it.
          *
          * Staging is the natural per-file verdict: it is already git's own
          * "I have looked at this and I want it", it is reversible, and it is
          * what the commit below then takes. Reviewing file by file and
          * committing the set is the shape of the work.
          */}
        {props.staged ? (
          <button
            style={S.acceptedBtn}
            onClick={props.onUnstage}
            disabled={props.busy}
            title="Unstage this file"
          >
            ✓ accepted
          </button>
        ) : (
          <button
            style={S.linkBtn}
            onClick={props.onStage}
            disabled={props.busy}
            title="Stage this file"
          >
            accept
          </button>
        )}
        <button
          style={S.linkBtn}
          onClick={() => { setOpenDiff((v) => !v); props.onOpen(); }}
        >
          open
        </button>
      </div>

      <div style={S.wasIsNow}>
        <div style={S.was}>
          <div style={S.colLabel}>WAS</div>
          <div style={{ ...TYPE.mono115, color: INK.i4 }}>{states.was}</div>
        </div>
        <div style={S.isNow}>
          <div style={S.colLabel}>IS NOW</div>
          <div style={{ ...TYPE.mono115, color: INK.i1 }}>{states.now}</div>
        </div>
      </div>

      <div style={{ ...TYPE.body115, color: cons.risky ? STATE.warn : INK.i3 }}>
        {cons.text}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    paddingTop: "5vh", zIndex: 50,
    animation: "fove-fade-in 120ms ease-out",
  },
  /** 872px, per the handoff. */
  card: {
    width: "min(872px, 94%)", maxHeight: "88vh", display: "flex", flexDirection: "column",
    background: SURFACE.s0, border: `1px solid ${BORDER.b2}`, borderRadius: RADIUS.card,
    boxShadow: SHADOW.card, overflow: "hidden", outline: "none",
    animation: "fove-rise 160ms ease-out",
  },

  topbar: {
    display: "flex", alignItems: "center", gap: 12, height: 44, padding: "0 16px",
    background: SURFACE.s1, borderBottom: `1px solid ${BORDER.b2}`, flexShrink: 0,
  },
  claimId: { ...TYPE.eyebrow, color: INK.i4 },
  claimTitle: { ...TYPE.title15, fontSize: 12.5, color: INK.i1 },
  count: { ...TYPE.body115, color: INK.i4 },
  runPill: {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "3px 9px", borderRadius: RADIUS.pill,
    background: BRAND.wash, border: `1px solid ${BRAND.edge}`,
    ...TYPE.body115, color: INK.i1,
  },
  dot: {
    width: 6, height: 6, borderRadius: "50%", background: BRAND.brand,
    animation: "fove-pulse 1.6s ease-in-out infinite",
  },
  ghost: {
    padding: "4px 10px", borderRadius: RADIUS.chip, border: `1px solid ${BORDER.b2}`,
    background: "transparent", color: INK.i3, ...TYPE.body115, cursor: "pointer",
  },
  kbd: { color: INK.i5, marginLeft: 5, fontSize: 10 },

  body: {
    // flex:1 + minHeight:0 are what make this actually scroll: the card is a
    // flex column with overflow:hidden, so without them the body grows past
    // the card and the overflow is clipped away rather than scrolled to.
    flex: 1, minHeight: 0,
    overflowY: "auto", padding: "18px 20px 20px",
    display: "flex", flexDirection: "column", gap: 16,
  },
  empty: { padding: "56px 20px", textAlign: "center" },

  eyebrow: { ...TYPE.eyebrow, color: INK.i5, marginBottom: 9 },
  ask: { ...TYPE.title17, color: INK.i1, margin: "0 0 10px", maxWidth: "62ch", textWrap: "pretty" },
  askMeta: {
    display: "flex", alignItems: "center", gap: 8,
    ...TYPE.body115, color: INK.i4, fontVariantNumeric: "tabular-nums",
  },
  chip: {
    padding: "2px 8px", borderRadius: RADIUS.pill, background: BRAND.wash,
    border: `1px solid ${BRAND.edge}`, color: BRAND.brandText, fontSize: 10.5,
    fontFamily: FONT.product,
  },

  summaryRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch" },
  summaryNeutral: {
    flex: 1, minWidth: 220, padding: "12px 14px", borderRadius: RADIUS.box,
    background: SURFACE.s1, border: `1px solid ${BORDER.b1}`,
    display: "flex", flexDirection: "column",
  },
  summaryWarn: {
    flex: 1, minWidth: 220, padding: "12px 14px", borderRadius: RADIUS.box,
    background: STATE.warnWash, border: `1px solid ${STATE.warnEdge}`,
    display: "flex", flexDirection: "column",
  },

  fileCard: {
    borderRadius: RADIUS.box, background: SURFACE.s1, border: `1px solid ${BORDER.b1}`,
    padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9,
  },
  fileHead: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  filePath: { ...TYPE.mono115, fontWeight: 500, color: INK.i1 },
  linkBtn: {
    background: "transparent", border: "none", color: BRAND.brandText,
    ...TYPE.body115, cursor: "pointer", padding: 0,
  },

  wasIsNow: { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 },
  was: { padding: "9px 11px", borderRadius: 7, background: "rgba(210,204,192,.05)" },
  isNow: { padding: "9px 11px", borderRadius: 7, background: "rgba(82,81,253,.1)" },
  colLabel: { ...TYPE.mono105, fontSize: 9.5, color: INK.i5, marginBottom: 5 },

  carriedList: { display: "flex", flexWrap: "wrap", gap: 6 },
  carriedItem: {
    ...TYPE.mono105, color: INK.i4, background: SURFACE.s2,
    border: `1px solid ${BORDER.b1}`, borderRadius: RADIUS.chip, padding: "3px 8px",
  },

  actions: { display: "flex", gap: 8, alignItems: "center", paddingTop: 4, flexWrap: "wrap" },
  // These were both inert when the row was first drawn, hence the
  // not-allowed cursor and the dimming. They do things now.
  secondary: {
    height: 36, padding: "0 16px", borderRadius: 8,
    border: `1px solid ${BORDER.b2}`, background: "transparent", color: INK.i2,
    ...TYPE.body125, cursor: "pointer",
  },
  primary: {
    display: "inline-flex", alignItems: "center", gap: 7,
    height: 36, padding: "0 16px", borderRadius: 8,
    border: `1px solid ${BRAND.edge}`, background: BRAND.brand, color: "#fff",
    ...TYPE.body125, cursor: "pointer",
  },
  acceptedBtn: {
    background: "transparent", border: "none", padding: "0 6px",
    color: STATE.good, fontFamily: FONT.product, fontSize: 11.5,
    cursor: "pointer",
  },
  composer: { display: "flex", flexDirection: "column", gap: 8, width: "100%" },
  composerRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  msg: {
    width: "100%", minHeight: 68, resize: "vertical", boxSizing: "border-box",
    padding: "9px 11px", borderRadius: 8,
    border: `1px solid ${BORDER.b2}`, background: SURFACE.s1, color: INK.i1,
    fontFamily: FONT.product, fontSize: 13, lineHeight: 1.5, outline: "none",
  },

  histRow: { display: "flex", alignItems: "baseline", gap: 12 },
  histWhen: {
    ...TYPE.mono105, color: INK.i5, width: 62, flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  histText: {
    ...TYPE.body115, color: INK.i3,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
};
