/**
 * Parsers for git's porcelain formats.
 *
 * Pure string -> data, with no child_process, so every shape git can emit
 * (renames, unmerged paths, untracked, detached HEAD, spaces in filenames) is
 * testable without a repository.
 *
 * Porcelain v2 is used deliberately over v1: it is explicitly documented as
 * machine-readable and stable, and it distinguishes staged from unstaged state
 * without guessing at column positions.
 */

export type FileStatus =
  | "modified" | "added" | "deleted" | "renamed" | "copied"
  | "untracked" | "ignored" | "unmerged";

export interface FileChange {
  path: string;
  /** Previous path, for renames and copies. */
  from?: string;
  /** Index (staged) state. */
  staged: FileStatus | null;
  /** Worktree (unstaged) state. */
  unstaged: FileStatus | null;
}

export interface RepoStatus {
  branch?: string;
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: FileChange[];
}

/** Map a porcelain v2 XY code letter to a status. */
function code(c: string): FileStatus | null {
  switch (c) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case ".": return null;
    default: return "modified";
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * NUL-separated is required, not optional: it is the only form that survives
 * filenames containing spaces, quotes or newlines without git escaping them.
 * Rename entries occupy two NUL-separated fields (new path, then old path).
 */
export function parseStatus(out: string): RepoStatus {
  const status: RepoStatus = { ahead: 0, behind: 0, detached: false, files: [] };
  const parts = out.split("\0");

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;

    if (line.startsWith("# branch.oid ")) {
      status.oid = line.slice(13).trim();
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      if (head === "(detached)") status.detached = true;
      else status.branch = head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice(18).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    const kind = line[0];
    if (kind === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const sp = line.split(" ");
      const xy = sp[1] ?? "..";
      const path = sp.slice(8).join(" ");
      if (path) status.files.push({ path, staged: code(xy[0]!), unstaged: code(xy[1]!) });
    } else if (kind === "2") {
      // 2 <XY> ... <path>  then the original path in the NEXT NUL field.
      const sp = line.split(" ");
      const xy = sp[1] ?? "..";
      const path = sp.slice(9).join(" ");
      const from = parts[++i] ?? undefined;
      if (path) status.files.push({ path, from, staged: code(xy[0]!), unstaged: code(xy[1]!) });
    } else if (kind === "u") {
      const path = line.split(" ").slice(10).join(" ");
      if (path) status.files.push({ path, staged: "unmerged", unstaged: "unmerged" });
    } else if (kind === "?") {
      status.files.push({ path: line.slice(2), staged: null, unstaged: "untracked" });
    } else if (kind === "!") {
      status.files.push({ path: line.slice(2), staged: null, unstaged: "ignored" });
    }
  }
  return status;
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  /** True for the checkout the app is currently pointed at. */
  current?: boolean;
  detached?: boolean;
  locked?: boolean;
  prunable?: boolean;
  bare?: boolean;
}

/** Parse `git worktree list --porcelain`: records separated by blank lines. */
export function parseWorktrees(out: string, cwd?: string): Worktree[] {
  const trees: Worktree[] = [];
  let cur: Worktree | null = null;

  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur) trees.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("locked")) cur.locked = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) trees.push(cur);

  if (cwd) for (const t of trees) if (t.path === cwd) t.current = true;
  return trees;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "context" | "add" | "del" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiff {
  path: string;
  from?: string;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * Parse unified diff output into per-file hunks with real line numbers, so a
 * click on a line can open the right place in an editor.
 */
export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) {
      if (hunk) file.hunks.push(hunk);
      files.push(file);
    }
    hunk = null;
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      // b/<path> is authoritative for the current name.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = {
        path: m?.[2] ?? line.slice(11),
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!file) continue;

    if (line.startsWith("rename from ")) { file.from = line.slice(12); continue; }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      if (hunk) file.hunks.push(hunk);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: m?.[3]?.trim() ?? "", oldStart: oldNo, newStart: newNo, lines: [] };
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo });
      newNo++;
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo++;
      file.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line.slice(2) }); // "\ No newline at end of file"
    }
  }
  pushFile();
  return files;
}

/** Short label for a change, for list rows. */
export function statusLabel(f: FileChange): string {
  const s = f.staged ?? f.unstaged;
  switch (s) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "untracked": return "?";
    case "ignored": return "!";
    case "unmerged": return "U";
    default: return "M";
  }
}
