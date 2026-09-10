/**
 * The write half of the git surface: stage, commit, stash, push, and the
 * commit graph.
 *
 * Split out from `GitStatus.tsx` because the risk profile differs. Reading a
 * repository is safe; these commands change it, and two of them (discard,
 * stash drop) destroy work that git cannot recover. Anything unrecoverable
 * asks first and names exactly what it will affect.
 *
 * Every failure shows git's own stderr verbatim. A rejected push or a failing
 * pre-commit hook is precisely the text the user needs, and summarising it is
 * how a tool becomes useless at the moment it matters most.
 */

import { useCallback, useEffect, useState } from "react";
import { C } from "../ui/Chrome.js";
import { layout, graphWidth, type GraphRow } from "../../shared/git-graph.js";
import type { FileDiff } from "../../shared/git-parse.js";

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  when: number;
  subject: string;
  refs: string[];
}

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
}

interface WriteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Lane colours, cycled. Colour follows the lane, so the graph does not flicker.
 *
 * Deliberately muted: with ~20 active branches the colours repeat anyway, so
 * they read as "these are different lanes" rather than as an identity. The one
 * lane that *is* identified -- the branch you are on -- is drawn in `HEAD_LANE`
 * below, brighter and thicker than everything else, because "where am I" is
 * the question this graph most often has to answer.
 */
const LANES = ["#5a7fb8", "#5c9668", "#a8894a", "#8a6ba3", "#a86469", "#4d9199"];

/** The lane carrying HEAD. The only colour in the graph that means something. */
const HEAD_LANE = "#2f6feb";

/** One row of `wtList` — the fields the worktree tab shows or guards on. */
interface WorktreeRow {
  path: string;
  name: string;
  branch?: string;
  current?: boolean;
  locked?: boolean;
  dirty?: number;
  agents: number;
}

/**
 * The commit form and the panel strip, as two elements the caller places.
 *
 * A hook rather than a component because these two pieces belong on opposite
 * sides of the parent's file list -- commit above, graph/stash/worktree below
 * -- while sharing one `tab` state and the loaders keyed off it. Returning
 * both from one call keeps that state here instead of hoisting it.
 */
export function useGitActions(props: {
  root: string;
  /** Paths git reports as changed, for the staging buttons. */
  staged: string[];
  unstaged: string[];
  branch?: string;
  onChanged: () => void;
  /** Open a file in the editor pane, optionally at a line. */
  onOpen?: (path: string, line?: number) => void;
}) {
  const { root, onChanged } = props;
  /**
   * Which lower panel is open, or null for none.
   *
   * "changes" left this union when committing stopped being a tab: it is the
   * permanent top of the pane now, so the only question is which occasional
   * view is open underneath -- and "none" is the common answer.
   */
  const [tab, setTab] = useState<"graph" | "stash" | "worktree" | null>(null);
  const [wtName, setWtName] = useState("");
  const [wtSteps, setWtSteps] = useState<{ step: string; ok: boolean; detail?: string }[] | null>(null);
  const [wtrees, setWtrees] = useState<WorktreeRow[]>([]);
  const [recipe, setRecipe] = useState<{ link?: string[]; run?: string[] } | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  /** Which commit is expanded in the graph. One at a time: this is a narrow pane. */
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  /**
   * Whose history the graph shows.
   *
   * "branch" is the default because it answers the question actually being
   * asked most of the time -- "what is on the branch I am on" -- and because
   * on a busy repo the full view buries HEAD dozens of rows down among other
   * people's branches.
   */
  const [scope, setScope] = useState<"branch" | "all">("branch");

  /** Run a mutating command, surfacing git's own message on failure. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const r = (await fn()) as WriteResult;
        if (r && r.ok === false) setError(r.stderr || r.stdout || "git failed");
        else if (okMsg) setNotice(okMsg);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const loadGraph = useCallback(async () => {
    setCommits((await window.th.gitCommits(root, 120, scope === "all")) as Commit[]);
  }, [root, scope]);

  const loadStashes = useCallback(async () => {
    setStashes((await window.th.gitStashList(root)) as StashEntry[]);
  }, [root]);

  const loadWorktrees = useCallback(async () => {
    setWtrees((await window.th.wtList(root)) as WorktreeRow[]);
  }, [root]);

  useEffect(() => {
    // A commit expanded in one scope may not exist in the other.
    setOpenCommit(null);
  }, [scope]);

  useEffect(() => {
    if (tab === "graph") void loadGraph();
    if (tab === "stash") void loadStashes();
    if (tab === "worktree") {
      void (async () => {
        const r = (await window.th.wsRecipe(root)) as {
          recipe: { link?: string[]; run?: string[] };
        };
        setRecipe(r?.recipe ?? null);
      })();
      void loadWorktrees();
    }
  }, [tab, root, loadGraph, loadStashes, loadWorktrees]);

  /**
   * Create a worktree beside the repository and apply its recipe.
   *
   * Placed next to the checkout rather than inside it, so the new tree is not
   * a nested working copy of the repo it came from.
   */
  const createWorktree = useCallback(async () => {
    const name = wtName.trim();
    if (!name) return;
    setBusy(true);
    setWtSteps(null);
    try {
      const path = `${root.slice(0, root.lastIndexOf("/"))}/${root.split("/").pop()}-${name}`;
      const r = (await window.th.wsCreate({
        repoRoot: root, path, branch: name, newBranch: true,
      })) as { ok: boolean; path: string; steps: { step: string; ok: boolean; detail?: string }[] };
      setWtSteps(r.steps);
      if (r.ok) setWtName("");
      await loadWorktrees();
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [root, wtName, onChanged, loadWorktrees]);

  /**
   * Close a worktree: detach it from the repo and delete its directory.
   *
   * The main process owns the refusals (main worktree, current worktree,
   * locked, live agents) so they cannot be bypassed by a stale render -- this
   * only has to name the cost before asking, and offer the one override git
   * allows. Uncommitted work is the override, and it is a separate, blunter
   * prompt: the first confirm is "delete a directory", the second is "throw
   * away work", and those deserve different answers.
   */
  const closeWorktree = useCallback(async (w: WorktreeRow) => {
    if (!confirm(`Close ${w.name}? The directory at ${w.path} is deleted. The branch is kept.`)) return;
    setBusy(true);
    try {
      let r = await window.th.wtRemove(root, w.path);
      // Gated on the main process's own verdict, not on `w.dirty`: the row can
      // be a render behind, and a tree that is merely dirty-looking may have
      // been refused for a lock or a live agent instead. Asking "lose your
      // work?" about one of those seeks consent for the wrong loss.
      if (!r.ok && r.retryWithForce) {
        if (confirm(`${w.name} has ${w.dirty ?? 0} uncommitted file(s). Close anyway and lose them?`)) {
          r = await window.th.wtRemove(root, w.path, true);
        } else {
          return;
        }
      }
      if (r.ok) setNotice(`closed ${w.name}`);
      else setError(r.error ?? "could not close worktree");
      await loadWorktrees();
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [root, onChanged, loadWorktrees]);

  const commit = async () => {
    if (!message.trim()) { setError("a commit needs a message"); return; }
    await act(() => window.th.gitCommit(root, message, { amend }), "committed");
    setMessage("");
    setAmend(false);
    if (tab === "graph") void loadGraph();
  };

  const rows = layout(commits);
  const width = graphWidth(rows);

  /*
   * The lane the checked-out branch sits in.
   *
   * Found by ref rather than by position: `git log` decorates the row with
   * "HEAD -> name", and on a detached HEAD with a bare "HEAD". Matching the
   * branch name as well covers the case where HEAD's decoration is missing but
   * the branch tip is still in the window.
   *
   * -1 when the branch tip is older than the 120 commits fetched, in which
   * case nothing is highlighted -- which is honest, rather than colouring an
   * arbitrary lane and implying it is yours.
   */
  const headLane = (() => {
    const branch = props.branch;
    for (const r of rows) {
      for (const ref of r.commit.refs) {
        if (ref.startsWith("HEAD ->") || ref === "HEAD") return r.lane;
        if (branch && (ref === branch || ref === `refs/heads/${branch}`)) return r.lane;
      }
    }
    return -1;
  })();

  /** The strip and whichever panel it has open, for the parent to place. */
  const panels = (
    <>
      {/*
        * Committing is not a tab, and the strip is not on top.
        *
        * Committing is what this pane is for, so it is always the top of the
        * pane rather than one of four peers -- reaching the graph used to hide
        * the commit form behind a tab. The three occasional views moved below
        * the file list instead, which is the order you actually read in:
        * commit what you staged, see what changed, then consult history.
        *
        * Rendered through `renderPanels` because the file list lives in the
        * parent: this component keeps `tab` and the loaders keyed off it, and
        * hands the parent the lower half to place. Clicking the active tab
        * closes it -- the way out is the same button as the way in.
        */}
      <div style={S.tabs}>
        <button style={tabStyle(tab === "graph")}
          onClick={() => setTab(tab === "graph" ? null : "graph")}>graph</button>
        <button style={tabStyle(tab === "stash")}
          onClick={() => setTab(tab === "stash" ? null : "stash")}>
          stash{stashes.length > 0 ? ` ${stashes.length}` : ""}
        </button>
        <button style={tabStyle(tab === "worktree")}
          onClick={() => setTab(tab === "worktree" ? null : "worktree")}>
          worktree
        </button>
        <div style={{ flex: 1 }} />
        {tab && (
          <button style={S.ghost} title="Close this panel" onClick={() => setTab(null)}>✕</button>
        )}
      </div>
      {tab === "graph" && (
        <>
        <div style={S.scopeBar}>
          <button
            style={scopeStyle(scope === "branch")}
            onClick={() => setScope("branch")}
            title="Only this branch's line of history"
          >
            this branch
          </button>
          <button
            style={scopeStyle(scope === "all")}
            onClick={() => setScope("all")}
            title="Every branch in the repository"
          >
            all branches
          </button>
          <div style={{ flex: 1 }} />
          <span style={S.scopeNote}>
            {scope === "branch"
              ? props.branch ?? "detached"
              : `${rows.length} commits, all refs`}
          </span>
        </div>
        <div style={S.list}>
          {rows.length === 0 ? (
            <div style={S.empty}>no commits</div>
          ) : (
            rows.map((r) => (
              <GraphRowView
                key={r.commit.hash}
                row={r}
                width={width}
                root={root}
                open={openCommit === r.commit.hash}
                onToggle={() =>
                  setOpenCommit((cur) => (cur === r.commit.hash ? null : r.commit.hash))
                }
                onOpen={props.onOpen}
                headLane={headLane}
              />
            ))
          )}
        </div>
        </>
      )}

      {tab === "worktree" && (
        <div style={S.body}>
          <div style={S.rowBar}>
            <input
              style={{ ...S.message, minHeight: 0, height: 26, flex: 1 }}
              placeholder="new branch name"
              value={wtName}
              onChange={(e) => setWtName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // app shortcuts must not fire while typing
                if (e.key === "Enter") void createWorktree();
              }}
            />
            <button style={S.primary} disabled={busy || !wtName.trim()}
              onClick={() => void createWorktree()}>
              create
            </button>
          </div>

          {wtrees.length > 0 && (
            <div style={S.wtList}>
              {wtrees.map((w, i) => {
                // The main worktree is first in git's own listing. Neither it
                // nor the current one can be closed, and saying why beats
                // showing a button that always fails.
                const isMain = i === 0;
                const why = isMain ? "the main worktree"
                  : w.current ? "the worktree you are in"
                  : w.locked ? "locked"
                  : w.agents > 0 ? `${w.agents} live session${w.agents === 1 ? "" : "s"}`
                  : null;
                return (
                  /*
                   * Two lines, not five columns. Name, branch, dirty, agents
                   * and the reason a tree cannot be closed were five inline
                   * spans in one non-wrapping row, so in a slim pane every
                   * one of them broke mid-word -- "the main worktree" became
                   * a column of syllables. Identity first, then the numbers
                   * and the action, each wrapping as a unit.
                   */
                  <div key={w.path} style={S.wtRow}>
                    <div style={S.wtIdentity}>
                      <span style={{ ...S.wtName, color: w.current ? C.fg : C.dim }}>
                        {w.current ? "● " : ""}{w.name}
                      </span>
                      <span style={S.wtBranch} title={w.branch ?? "detached"}>
                        {w.branch ?? "detached"}
                      </span>
                    </div>
                    <div style={S.wtMeta}>
                      {w.dirty !== undefined && w.dirty > 0 && (
                        <span style={{ color: "#d29922" }}>{w.dirty} dirty</span>
                      )}
                      {w.agents > 0 && (
                        <span style={{ color: "#3fb950" }}>
                          {w.agents} agent{w.agents === 1 ? "" : "s"}
                        </span>
                      )}
                      <div style={{ flex: 1 }} />
                      {why ? (
                        <span style={{ color: C.faint, fontSize: 10, whiteSpace: "nowrap" }}>
                          {why}
                        </span>
                      ) : (
                        <button
                          style={S.danger}
                          disabled={busy}
                          title={`Remove ${w.path} — the branch is kept`}
                          onClick={() => void closeWorktree(w)}
                        >
                          close
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {recipe && (() => {
            // Config and dependencies are linked for different reasons -- one
            // holds values only this checkout has, the other is expensive to
            // reinstall -- so they are worth naming separately.
            const links = recipe.link ?? [];
            const deps = links.filter((p) => /(^|\/)(node_modules|\.?venv|vendor\/bundle|\.yarn\/cache)$/.test(p));
            const config = links.filter((p) => !deps.includes(p));
            return (
              <div style={S.recipe}>
                {links.length === 0 ? (
                  <>nothing to link — no untracked config or installed dependencies found</>
                ) : (
                  <>
                    {config.length > 0 && (
                      <div>config: <b style={{ color: C.fg }}>{config.join(", ")}</b></div>
                    )}
                    {deps.length > 0 && (
                      <div>
                        dependencies: <b style={{ color: C.fg }}>{deps.join(", ")}</b>
                        <span style={{ color: C.faint }}> · shared, not reinstalled</span>
                      </div>
                    )}
                  </>
                )}
                {(recipe.run ?? []).length > 0 && (
                  <div>then run <b style={{ color: C.fg }}>{(recipe.run ?? []).join(" && ")}</b></div>
                )}
              </div>
            );
          })()}

          {wtSteps && (
            // Every step, including the skipped ones: "already had a .env" is
            // information, not noise.
            <div style={S.steps}>
              {wtSteps.map((st, i) => (
                <div key={i} style={S.step}>
                  <span style={{ color: st.ok ? "#3fb950" : "#f85149" }}>{st.ok ? "✓" : "✕"}</span>
                  <span style={{ color: C.fg }}>{st.step}</span>
                  {st.detail && <span style={{ color: C.faint }}>— {st.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "stash" && (
        <div style={S.list}>
          {stashes.length === 0 ? (
            <div style={S.empty}>no stashes</div>
          ) : (
            stashes.map((s) => (
              <div key={s.ref} style={S.stashRow}>
                {/*
                  * `nowrap` is what was missing: ellipsis without it does
                  * nothing, so a slim pane broke a stash message to one
                  * character per line and pushed the buttons far apart.
                  */}
                <span style={{ color: C.faint, flexShrink: 0 }}>{s.ref}</span>
                <span
                  style={{
                    flex: 1, minWidth: 0, color: C.fg,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  title={s.message}
                >
                  {s.message}
                </span>
                <button style={S.ghost} disabled={busy}
                  onClick={() => void act(async () => {
                    const r = await window.th.gitStashApply(root, s.ref);
                    await loadStashes();
                    return r;
                  }, "applied")}>apply</button>
                <button style={S.ghost} disabled={busy}
                  onClick={() => void act(async () => {
                    const r = await window.th.gitStashPop(root, s.ref);
                    await loadStashes();
                    return r;
                  }, "popped")}>pop</button>
                <button style={S.danger} disabled={busy}
                  onClick={() => {
                    if (!confirm(`Drop ${s.ref}? This cannot be undone.`)) return;
                    void act(async () => {
                      const r = await window.th.gitStashDrop(root, s.ref);
                      await loadStashes();
                      return r;
                    }, "dropped");
                  }}>drop</button>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );

  const form = (
      <div style={S.wrap}>
        {/* Remote actions on their own row, so a slim pane wraps instead of
            scrolling the strip they used to share. */}
        <div style={S.remoteBar}>
          <button style={S.ghost} disabled={busy}
            onClick={() => void act(() => window.th.gitFetch(root), "fetched")}>fetch</button>
          <button style={S.ghost} disabled={busy}
            onClick={() => void act(() => window.th.gitPull(root, { rebase: true }), "pulled")}>pull</button>
          <div style={{ flex: 1 }} />
          <button style={S.primary} disabled={busy}
            onClick={() => void act(() => window.th.gitPush(root, {}), "pushed")}>push</button>
        </div>

        {/* git's own words, unmodified and scrollable -- hook output can be long. */}
        {error && <pre style={S.error}>{error}</pre>}
        {notice && <div style={S.notice}>{notice}</div>}
        <div style={S.body}>
          <div style={S.rowBar}>
            <button style={S.ghost} disabled={busy || props.unstaged.length === 0}
              onClick={() => void act(() => window.th.gitStage(root, props.unstaged))}>
              stage {props.unstaged.length}
            </button>
            <button style={S.ghost} disabled={busy || props.staged.length === 0}
              onClick={() => void act(() => window.th.gitUnstage(root, props.staged))}>
              unstage {props.staged.length}
            </button>
            <button style={S.danger} disabled={busy || props.unstaged.length === 0}
              onClick={() => {
                // Discarding cannot be undone by git, so name the cost first.
                if (!confirm(`Discard changes to ${props.unstaged.length} file(s)? This cannot be undone.`)) return;
                void act(() => window.th.gitDiscard(root, props.unstaged), "discarded");
              }}>
              discard
            </button>
          </div>

          <textarea
            style={S.message}
            placeholder={amend ? "amend the last commit…" : "commit message"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            // The pane's own shortcuts must not fire while typing a message.
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
            }}
          />
          <div style={S.rowBar}>
            <label style={S.check}>
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
              amend
            </label>
            <div style={{ flex: 1 }} />
            <span style={S.hint}>⌘↵</span>
            <button style={S.primary} disabled={busy} onClick={() => void commit()}>
              {amend ? "amend" : "commit"} {props.staged.length > 0 ? `(${props.staged.length})` : ""}
            </button>
          </div>

          <div style={S.rowBar}>
            <button style={S.ghost} disabled={busy}
              onClick={() => void act(() => window.th.gitStashPush(root, message || undefined, true), "stashed")}>
              stash changes
            </button>
          </div>
        </div>
      </div>
  );

  return { form, panels };
}

/**
 * One commit row: the lane graphic, then the commit itself, and -- when
 * expanded -- every file it changed.
 *
 * The diff is fetched on expand rather than with the graph: 120 commits'
 * worth of diffs is a lot of git processes for something you look at one of.
 */
function GraphRowView(props: {
  row: GraphRow<Commit>;
  width: number;
  root: string;
  /** Lane index carrying the checked-out branch, or -1 when it is off-window. */
  headLane: number;
  open: boolean;
  onToggle: () => void;
  onOpen?: (path: string, line?: number) => void;
}) {
  const { row, width } = props;
  const onHead = props.headLane >= 0;
  const laneColor = (i: number): string =>
    onHead && i === props.headLane ? HEAD_LANE : LANES[i % LANES.length]!;
  const COL = 12;
  const H = 22;
  const w = Math.max(1, width) * COL;
  return (
    <>
    <div
      style={{ ...S.commitRow, ...(props.open ? S.commitRowOpen : null) }}
      title={`${row.commit.hash}\n${row.commit.author}`}
      onClick={props.onToggle}
    >
      <svg width={w} height={H} style={{ flex: `0 0 ${w}px` }}>
        {row.edges.map((e, i) => {
          const x1 = e.from * COL + COL / 2;
          const x2 = e.to * COL + COL / 2;
          // An edge that ends here stops at the dot; one passing through spans
          // the full row height.
          const y1 = 0;
          const y2 = e.ends ? H / 2 : H;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
              stroke={laneColor(e.to)}
              strokeWidth={onHead && e.to === props.headLane ? 2.4 : 1.4}
              fill="none"
            />
          );
        })}
        <circle
          cx={row.lane * COL + COL / 2}
          cy={H / 2}
          r={onHead && row.lane === props.headLane ? 4.2 : 3}
          fill={laneColor(row.lane)}
        />
      </svg>
      <span style={{ ...S.chev, transform: props.open ? "rotate(90deg)" : "none" }}>›</span>
      <span style={S.hash}>{row.commit.hash.slice(0, 7)}</span>
      <span style={S.subject}>{row.commit.subject}</span>
      {row.commit.refs.map((r) => (
        <span key={r} style={S.ref}>{r.replace("HEAD -> ", "")}</span>
      ))}
    </div>
    {props.open && (
      <CommitDetail root={props.root} commit={row.commit} onOpen={props.onOpen} />
    )}
    </>
  );
}

/**
 * The files a commit changed, each expandable to its diff.
 *
 * A merge is labelled rather than silently reinterpreted. `git diff` on a
 * merge shows the change against the *first* parent -- "what landed on this
 * branch" -- which is the useful reading but is not the whole truth of the
 * merge, and a UI that does not say so is lying by omission.
 */
function CommitDetail(props: {
  root: string;
  commit: Commit;
  onOpen?: (path: string, line?: number) => void;
}) {
  const { root, commit } = props;
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [parents, setParents] = useState<number | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFiles(null);
    void (async () => {
      const [d, p] = await Promise.all([
        window.th.gitDiff(root, { commit: commit.hash }) as Promise<FileDiff[]>,
        window.th.gitCommitParents(root, commit.hash) as Promise<number>,
      ]);
      if (!live) return;
      setParents(p);
      setFiles(d);
      // One changed file is the common case; open it rather than making the
      // user click twice to see the only thing there is to see.
      if (d.length === 1) setOpenFile(d[0]!.path);
    })();
    return () => { live = false; };
  }, [root, commit.hash]);

  if (files === null) {
    return <div style={S.detailNote}>loading…</div>;
  }

  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div style={S.detail}>
      <div style={S.detailHead}>
        <span style={{ color: C.fg }}>{files.length} file{files.length === 1 ? "" : "s"}</span>
        <span style={{ color: "#3fb950" }}>+{adds}</span>
        <span style={{ color: "#f85149" }}>−{dels}</span>
        <span style={{ flex: 1 }} />
        <span style={S.detailAuthor}>{commit.author}</span>
      </div>

      {parents !== null && parents > 1 && (
        <div style={S.mergeNote}>
          merge of {parents} parents — showing the change against the first parent only
        </div>
      )}

      {files.length === 0 && (
        <div style={S.detailNote}>
          {parents !== null && parents > 1
            ? "no changes against the first parent"
            : "no textual changes (empty commit, or binary only)"}
        </div>
      )}

      {files.map((f) => (
        <div key={f.path}>
          <div
            style={S.fileRow}
            onClick={() => setOpenFile((cur) => (cur === f.path ? null : f.path))}
            title={f.path}
          >
            <span style={{ ...S.chev, transform: openFile === f.path ? "rotate(90deg)" : "none" }}>›</span>
            <span style={S.filePath}>
              {f.from && <span style={{ color: C.faint }}>{f.from} → </span>}
              {f.path}
            </span>
            <span style={{ color: "#3fb950" }}>+{f.additions}</span>
            <span style={{ color: "#f85149" }}>−{f.deletions}</span>
            <button
              style={S.openBtn}
              title="Open in the editor pane"
              onClick={(e) => { e.stopPropagation(); props.onOpen?.(`${root}/${f.path}`); }}
            >
              open
            </button>
          </div>

          {openFile === f.path && (
            <div style={S.fileDiff}>
              {f.binary ? (
                <div style={S.detailNote}>binary file</div>
              ) : f.hunks.length === 0 ? (
                <div style={S.detailNote}>no textual changes</div>
              ) : (
                f.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div style={S.hunkHeader}>
                      @@ {h.oldStart} → {h.newStart} @@ {h.header}
                    </div>
                    {h.lines.map((l, li) => (
                      <div
                        key={li}
                        style={{
                          ...S.diffLine,
                          background:
                            l.kind === "add" ? "#0e2a16" : l.kind === "del" ? "#2d1214" : undefined,
                          color: l.kind === "add" ? "#7ee787" : l.kind === "del" ? "#ffa198" : C.dim,
                        }}
                        title="click to open at this line"
                        onClick={() => props.onOpen?.(`${root}/${f.path}`, l.newNo ?? l.oldNo)}
                      >
                        <span style={S.diffGutter}>{l.newNo ?? l.oldNo ?? ""}</span>
                        <span style={{ width: 10, flexShrink: 0 }}>
                          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                        </span>
                        <span style={S.diffCode}>{l.text || " "}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The scope toggle reads as a segmented control, not another tab. */
const scopeStyle = (on: boolean): React.CSSProperties => ({
  padding: "1px 8px",
  borderRadius: 3,
  border: `1px solid ${on ? "#33333d" : "transparent"}`,
  background: on ? "#1e1e28" : "transparent",
  color: on ? C.fg : C.faint,
  fontSize: 10.5,
  cursor: "pointer",
});

const tabStyle = (on: boolean): React.CSSProperties => ({
  padding: "2px 9px",
  borderRadius: 4,
  border: `1px solid ${on ? C.accent : "transparent"}`,
  background: on ? "#1a2233" : "transparent",
  color: on ? C.fg : C.faint,
  fontSize: 11,
  cursor: "pointer",
});

const S: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex", flexDirection: "column", minHeight: 0,
    borderTop: "1px solid #23232c",
    /*
     * Scrolls, and never takes more than half the pane.
     *
     * The toolbar wraps onto more rows as the pane narrows and the commit box
     * sits below it, so in a short pane this block is taller than the space
     * left for it -- measured at 226px of content inside a 192px pane, which
     * pushed the file list off the bottom entirely. The cap keeps the list
     * visible; the scroll keeps the commit button reachable.
     */
    overflowY: "auto", maxHeight: "50%", flexShrink: 0,
  },
  /* Everything wraps: one non-wrapping row scrolled the selected tab off-screen. */
  tabs: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4,
    padding: "5px 8px", background: "#12121a", borderTop: "1px solid #1c1c26",
  },
  remoteBar: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6,
    padding: "5px 8px", background: "#12121a", borderBottom: "1px solid #1c1c26",
  },
  body: { display: "flex", flexDirection: "column", gap: 6, padding: "6px 8px" },
  rowBar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 },
  message: {
    background: "#0d0d11", color: C.fg, border: "1px solid #2a2a34", borderRadius: 5,
    padding: "6px 8px", fontFamily: "system-ui", fontSize: 12, resize: "vertical",
    minHeight: 52, outline: "none",
  },
  primary: {
    padding: "3px 12px", borderRadius: 4, border: "1px solid #2ea043",
    background: "#238636", color: "#fff", fontSize: 11, cursor: "pointer",
  },
  ghost: {
    padding: "3px 10px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
  },
  danger: {
    padding: "3px 10px", borderRadius: 4, border: "1px solid #6e2b30",
    background: "transparent", color: "#f85149", fontSize: 11, cursor: "pointer",
  },
  check: { display: "flex", alignItems: "center", gap: 4, color: C.faint, fontSize: 11 },
  hint: { color: C.faint, fontSize: 10, marginRight: 6 },
  error: {
    margin: "6px 8px", padding: "6px 8px", background: "#2a1214", border: "1px solid #6e2b30",
    borderRadius: 5, color: "#ffb4b4", fontSize: 11, whiteSpace: "pre-wrap",
    maxHeight: 140, overflow: "auto", fontFamily: "Menlo, monospace",
  },
  notice: { margin: "4px 8px", color: "#3fb950", fontSize: 11 },
  list: { overflow: "auto", minHeight: 0, padding: "2px 0" },
  scopeBar: {
    display: "flex", alignItems: "center", gap: 4, padding: "3px 8px",
    borderBottom: "1px solid #1c1c26", background: "#0e0e14",
  },
  scopeNote: { color: C.faint, fontSize: 10 },
  empty: { padding: 12, color: C.faint, fontSize: 11 },
  commitRow: {
    display: "flex", alignItems: "center", gap: 6, padding: "0 8px",
    height: 22, fontSize: 11, cursor: "pointer",
  },
  commitRowOpen: { background: "#151520" },
  chev: {
    color: C.faint, fontSize: 12, width: 8, flexShrink: 0,
    transition: "transform 120ms ease", display: "inline-block",
  },
  detail: {
    background: "#0d0d13", borderTop: "1px solid #23232c",
    borderBottom: "1px solid #23232c", margin: "0 0 2px",
  },
  detailHead: {
    display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
    fontSize: 11, color: C.faint, borderBottom: "1px solid #1c1c26",
  },
  detailAuthor: { color: C.faint, fontSize: 10 },
  detailNote: { padding: "6px 12px", color: C.faint, fontSize: 11 },
  mergeNote: {
    padding: "4px 10px", fontSize: 10, color: "#d29922",
    background: "#1d1a10", borderBottom: "1px solid #1c1c26",
  },
  fileRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "2px 10px",
    fontSize: 11, cursor: "pointer", lineHeight: "18px",
  },
  filePath: {
    flex: 1, color: C.fg, fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 10.5,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl",
    textAlign: "left",
  },
  fileDiff: {
    fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 10.5,
    borderTop: "1px solid #1c1c26", borderBottom: "1px solid #1c1c26",
    // Proportional, not a fixed 320px: this pane is often short (it shares a
    // column with a shell), and a fixed height there clips the diff to a few
    // lines while wasting space in a tall pane.
    maxHeight: "min(46vh, 420px)", overflow: "auto", background: C.bg,
  },
  // `min-content` so a long source line widens the row instead of being
  // squeezed to the container and clipped -- the parent scrolls horizontally,
  // but only if the rows are actually allowed to be wider than it.
  diffLine: {
    display: "flex", cursor: "pointer", lineHeight: "15px", whiteSpace: "pre",
    minWidth: "min-content",
  },
  diffGutter: { width: 40, textAlign: "right", paddingRight: 8, color: C.faint, flexShrink: 0 },
  diffCode: { flex: 1, paddingLeft: 2 },
  openBtn: {
    background: "transparent", border: "1px solid #33333d", color: C.dim,
    borderRadius: 4, padding: "0 6px", cursor: "pointer", fontSize: 10, flexShrink: 0,
  },
  hash: { color: "#8b949e", fontFamily: "Menlo, monospace", flex: "0 0 auto" },
  subject: { color: C.fg, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ref: {
    padding: "0 5px", borderRadius: 3, background: "#1c2333", color: "#58a6ff",
    fontSize: 10, flex: "0 0 auto",
  },
  recipe: {
    padding: "6px 8px", borderRadius: 5, background: "#12121a",
    border: "1px solid #23232c", color: C.faint, fontSize: 11, lineHeight: 1.5,
  },
  steps: { display: "flex", flexDirection: "column", gap: 3, marginTop: 4 },
  step: { display: "flex", gap: 6, fontSize: 11, alignItems: "baseline" },
  stashRow: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6,
    padding: "3px 8px", fontSize: 11, borderBottom: "1px solid #16161e",
  },
  wtList: {
    display: "flex", flexDirection: "column", marginTop: 4,
    borderRadius: 5, background: "#12121a", border: "1px solid #23232c",
  },
  wtRow: {
    display: "flex", flexDirection: "column", gap: 2,
    padding: "5px 8px", fontSize: 11, borderBottom: "1px solid #16161e",
  },
  wtIdentity: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 },
  /* The name is the identity, so it survives; the branch yields first. */
  wtName: { flexShrink: 0, whiteSpace: "nowrap" },
  wtBranch: {
    color: C.faint, flex: 1, minWidth: 0,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  wtMeta: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 },
};
