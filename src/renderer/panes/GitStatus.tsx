/**
 * Git pane: what changed, on which branch/worktree.
 *
 * Built for reviewing an agent's work: the change list is the primary content,
 * and clicking a file opens its diff *in the editor pane* -- a real Monaco
 * diff, side-by-side, syntax-highlighted, with an editable working-tree side
 * you can fix in place and save.
 *
 * This pane used to render its own diff in a column beside the list. It was a
 * hand-rolled hunk renderer squeezed into whatever width was left over, and
 * everything it did the editor does better and with more room. What is left
 * here is the part only this pane can do: what changed, what is staged, and
 * the way through to each one.
 */

import { useCallback, useEffect, useState } from "react";
import type { FileChange, RepoStatus } from "../../shared/git-parse.js";
import { statusLabel } from "../../shared/git-parse.js";
import { useGitActions } from "./GitActions.js";

const C = {
  bg: "#0d0d11", panel: "#14141a", line: "#22222a",
  fg: "#d8d8dc", dim: "#8a8a93", faint: "#5a5a63",
  add: "#3fb950", del: "#f05055", accent: "#2f6feb", warn: "#d29922",
};

const statusColor = (f: FileChange): string => {
  const s = f.staged ?? f.unstaged;
  return s === "added" || s === "untracked" ? C.add
    : s === "deleted" ? C.del
    : s === "renamed" ? C.accent
    : s === "unmerged" ? C.warn
    : C.dim;
};

export function GitStatusPane(props: {
  cwd: string;
  /** Open a file in fove's own editor pane. */
  onOpen?: (path: string, line?: number) => void;
  /** Open a file's changes as a diff tab in the editor pane. */
  onOpenDiff?: (path: string, rev?: string, revLabel?: string) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  /** Which row is highlighted -- the one whose diff was last opened. */
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await window.th.gitRoot(props.cwd);
    setRoot(r);
    // Status only: this polls every 3s, and `git worktree list` was a second
    // subprocess per tick for a list nothing reads any more.
    if (r) setStatus((await window.th.gitStatus(r)) as RepoStatus | null);
    setBusy(false);
  }, [props.cwd]);

  /**
   * Stage or unstage specific paths, then re-read.
   *
   * The refresh is what redraws the row: a staged file's `+` becomes `−`, and
   * the commit form's counts above follow from the same status.
   */
  const stagePaths = useCallback(async (paths: string[]) => {
    if (!root) return;
    await window.th.gitStage(root, paths);
    await refresh();
  }, [root, refresh]);

  const unstagePaths = useCallback(async (paths: string[]) => {
    if (!root) return;
    await window.th.gitUnstage(root, paths);
    await refresh();
  }, [root, refresh]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while the pane is open: an agent changes files behind our back.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  /*
   * The commit form and the panel strip come from one hook so they share
   * `tab`, but they render on opposite sides of the file list below: commit
   * above it, graph/stash/worktree under it, which is the order you read in.
   */
  const git = useGitActions({
    root: root ?? "",
    branch: status?.branch,
    staged: (status?.files ?? []).filter((f) => f.staged !== null).map((f) => f.path),
    unstaged: (status?.files ?? []).filter((f) => f.unstaged !== null).map((f) => f.path),
    onChanged: () => void refresh(),
    onOpen: props.onOpen,
  });

  /**
   * Show one file's changes in the editor pane.
   *
   * Always against HEAD, not against the index: "what has changed since the
   * last commit" is the question being asked when you are reading an agent's
   * work, and it is the one answer that is the same whether or not you have
   * already staged some of it. An untracked file has nothing at HEAD, which
   * the diff renders as an addition -- the same thing git does.
   */
  const showDiff = useCallback((f: FileChange) => {
    setSelected(f.path);
    if (!root) return;
    props.onOpenDiff?.(`${root}/${f.path}`, "HEAD", "HEAD");
  }, [root, props]);

  if (!root) {
    return (
      <div style={{ ...S.pane, color: C.faint, padding: 12 }}>
        {busy ? "checking…" : "not a git repository"}
      </div>
    );
  }

  return (
    <div style={S.pane}>
      <div style={S.header}>
        <span style={{ color: C.accent }}>⎇ {status?.branch ?? "(detached)"}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span style={{ color: C.dim }}>
            {status.ahead > 0 ? ` ↑${status.ahead}` : ""}{status.behind > 0 ? ` ↓${status.behind}` : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: C.faint }}>{status?.files.length ?? 0} changed</span>
      </div>

      {git.form}

      <div style={S.split}>
        <div style={S.list}>
          {/*
            * No worktree list here.
            *
            * It was read-only -- a dot and a branch name, nothing to click --
            * and it cost seven rows above the changes list, which is what this
            * sidebar is for. Everything it said is said better elsewhere: the
            * header above names the branch you are in, the pane's own worktree
            * tab creates and closes them, and the toolbar picker switches.
            */}
          <div style={S.sectionLabel}>changes</div>
          {(status?.files ?? []).length === 0 && (
            <div style={{ ...S.row, color: C.faint }}>clean</div>
          )}
          {(status?.files ?? []).map((f) => (
            <div
              key={f.path}
              onClick={() => showDiff(f)}
              onDoubleClick={() => props.onOpen?.(`${root}/${f.path}`)}
              style={{
                ...S.row,
                cursor: "pointer",
                background: selected === f.path ? "#1e2636" : undefined,
              }}
              title={`${f.path}${f.from ? ` (was ${f.from})` : ""} — click for the diff, double-click for the file`}
            >
              <span style={{ width: 14, color: statusColor(f) }}>{statusLabel(f)}</span>
              {/*
                * Filename first, directory dimmed behind it. Twenty paths
                * that share a prefix are told apart by their last segment,
                * and leading with the directory buries that segment behind
                * however many characters the prefix happens to be.
                */}
              <span style={{ color: selected === f.path ? C.fg : C.dim, flexShrink: 0 }}>
                {baseOf(f.path)}
              </span>
              <span style={{ ...S.ellipsis, color: C.faint, fontSize: 11 }}>
                {dirOf(f.path)}
              </span>
              {/*
                * Per file, because "stage all (13)" is no help when three of
                * the thirteen belong in this commit.
                *
                * A file can be staged and unstaged at once -- edited, staged,
                * then edited again -- so these are two independent conditions
                * rather than one either/or: that file gets both buttons, and
                * each acts on its own half.
                *
                * The click must not reach the row, which selects the file and
                * loads its diff.
                */}
              {f.unstaged !== null && (
                <button
                  style={S.rowBtn}
                  title={`Stage ${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (root) void stagePaths([f.path]);
                  }}
                >
                  +
                </button>
              )}
              {f.staged !== null && (
                <button
                  style={S.rowBtn}
                  title={`Unstage ${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (root) void unstagePaths([f.path]);
                  }}
                >
                  −
                </button>
              )}
              {/* The escape hatch stays, but is no longer the default. */}
              <button
                style={S.rowBtn}
                title="Open in VS Code"
                onClick={(e) => {
                  e.stopPropagation();
                  window.th.openInEditor(`${root}/${f.path}`);
                }}
              >
                ↗
              </button>
            </div>
          ))}
        </div>

      </div>

      {/* The lower half: whichever of graph/stash/worktree is open. */}
      <div style={S.panels}>{git.panels}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  pane: { display: "flex", flexDirection: "column", height: "100%", background: C.bg,
          color: C.fg, fontFamily: "system-ui", fontSize: 12, overflow: "hidden" },
  header: { display: "flex", gap: 6, alignItems: "center", padding: "5px 9px",
            background: C.panel, borderBottom: `1px solid ${C.line}`, flexShrink: 0 },
  split: { display: "flex", flex: 1, minHeight: 0 },
  /*
   * The lower half. Capped and scrollable so an open panel -- 54 stashes, a
   * long graph -- cannot push the file list above it off the pane.
   */
  panels: { display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "55%",
            overflowY: "auto", flexShrink: 0, borderTop: `1px solid ${C.line}` },
  /*
   * The whole width now that the diff lives in the editor. A change list is
   * mostly paths, and paths are exactly what a 240px column could not show.
   */
  list: { flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "4px 0" },
  sectionLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase",
                  padding: "6px 9px 2px", letterSpacing: 0.5 },
  row: { display: "flex", gap: 5, alignItems: "center", padding: "2px 9px", lineHeight: "17px" },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  /*
   * Square and small: the row is a 17px line, and these sit at the end of a
   * path that is already ellipsised, so they must cost almost no width.
   * `flexShrink: 0` keeps them from being squeezed away when the pane is
   * narrow -- which is exactly when a long path wants to eat the row.
   */
  rowBtn: {
    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
    borderRadius: 3, width: 17, height: 15, lineHeight: "13px", padding: 0,
    cursor: "pointer", fontSize: 12, flexShrink: 0,
  },
};

/** The directory part of a repo-relative path, blank at the repository root. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
