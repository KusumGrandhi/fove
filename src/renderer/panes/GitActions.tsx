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

/** Lane colours, cycled. Colour follows the lane, so the graph does not flicker. */
const LANES = ["#2f6feb", "#3fb950", "#d29922", "#a371f7", "#f85149", "#39c5cf"];

export function GitActions(props: {
  root: string;
  /** Paths git reports as changed, for the staging buttons. */
  staged: string[];
  unstaged: string[];
  branch?: string;
  onChanged: () => void;
}) {
  const { root, onChanged } = props;
  const [tab, setTab] = useState<"changes" | "graph" | "stash">("changes");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);

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
    setCommits((await window.th.gitCommits(root, 120)) as Commit[]);
  }, [root]);

  const loadStashes = useCallback(async () => {
    setStashes((await window.th.gitStashList(root)) as StashEntry[]);
  }, [root]);

  useEffect(() => {
    if (tab === "graph") void loadGraph();
    if (tab === "stash") void loadStashes();
  }, [tab, loadGraph, loadStashes]);

  const commit = async () => {
    if (!message.trim()) { setError("a commit needs a message"); return; }
    await act(() => window.th.gitCommit(root, message, { amend }), "committed");
    setMessage("");
    setAmend(false);
    if (tab === "graph") void loadGraph();
  };

  const rows = layout(commits);
  const width = graphWidth(rows);

  return (
    <div style={S.wrap}>
      <div style={S.tabs}>
        <button style={tabStyle(tab === "changes")} onClick={() => setTab("changes")}>changes</button>
        <button style={tabStyle(tab === "graph")} onClick={() => setTab("graph")}>graph</button>
        <button style={tabStyle(tab === "stash")} onClick={() => setTab("stash")}>
          stash{stashes.length > 0 ? ` ${stashes.length}` : ""}
        </button>
        <div style={{ flex: 1 }} />
        <button style={S.ghost} disabled={busy}
          onClick={() => void act(() => window.th.gitFetch(root), "fetched")}>fetch</button>
        <button style={S.ghost} disabled={busy}
          onClick={() => void act(() => window.th.gitPull(root, { rebase: true }), "pulled")}>pull</button>
        <button style={S.primary} disabled={busy}
          onClick={() => void act(() => window.th.gitPush(root, {}), "pushed")}>push</button>
      </div>

      {error && (
        // git's own words, unmodified and scrollable -- hook output can be long.
        <pre style={S.error}>{error}</pre>
      )}
      {notice && <div style={S.notice}>{notice}</div>}

      {tab === "changes" && (
        <div style={S.body}>
          <div style={S.rowBar}>
            <button style={S.ghost} disabled={busy || props.unstaged.length === 0}
              onClick={() => void act(() => window.th.gitStage(root, props.unstaged))}>
              stage all ({props.unstaged.length})
            </button>
            <button style={S.ghost} disabled={busy || props.staged.length === 0}
              onClick={() => void act(() => window.th.gitUnstage(root, props.staged))}>
              unstage all ({props.staged.length})
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
              stash all (incl. untracked)
            </button>
          </div>
        </div>
      )}

      {tab === "graph" && (
        <div style={S.list}>
          {rows.length === 0 ? (
            <div style={S.empty}>no commits</div>
          ) : (
            rows.map((r) => <GraphRowView key={r.commit.hash} row={r} width={width} />)
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
                <span style={{ color: C.faint, minWidth: 68 }}>{s.ref}</span>
                <span style={{ flex: 1, color: C.fg, overflow: "hidden", textOverflow: "ellipsis" }}>
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
    </div>
  );
}

/** One commit row: the lane graphic, then the commit itself. */
function GraphRowView(props: { row: GraphRow<Commit>; width: number }) {
  const { row, width } = props;
  const COL = 12;
  const H = 22;
  const w = Math.max(1, width) * COL;
  return (
    <div style={S.commitRow} title={`${row.commit.hash}\n${row.commit.author}`}>
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
              stroke={LANES[e.to % LANES.length]}
              strokeWidth={1.5}
              fill="none"
            />
          );
        })}
        <circle
          cx={row.lane * COL + COL / 2}
          cy={H / 2}
          r={3.5}
          fill={LANES[row.lane % LANES.length]}
        />
      </svg>
      <span style={S.hash}>{row.commit.hash.slice(0, 7)}</span>
      <span style={S.subject}>{row.commit.subject}</span>
      {row.commit.refs.map((r) => (
        <span key={r} style={S.ref}>{r.replace("HEAD -> ", "")}</span>
      ))}
    </div>
  );
}

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
  wrap: { display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid #23232c" },
  tabs: { display: "flex", alignItems: "center", gap: 4, padding: "5px 8px", background: "#12121a" },
  body: { display: "flex", flexDirection: "column", gap: 6, padding: "6px 8px" },
  rowBar: { display: "flex", alignItems: "center", gap: 6 },
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
  empty: { padding: 12, color: C.faint, fontSize: 11 },
  commitRow: {
    display: "flex", alignItems: "center", gap: 6, padding: "0 8px",
    height: 22, fontSize: 11, cursor: "default",
  },
  hash: { color: "#8b949e", fontFamily: "Menlo, monospace", flex: "0 0 auto" },
  subject: { color: C.fg, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ref: {
    padding: "0 5px", borderRadius: 3, background: "#1c2333", color: "#58a6ff",
    fontSize: 10, flex: "0 0 auto",
  },
  stashRow: {
    display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", fontSize: 11,
  },
};
