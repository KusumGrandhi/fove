# An AI-optimized developer app

## What this is

A desktop app for developing with an AI agent. Not a terminal wrapper with
features bolted on — an IDE whose organizing assumption is that an agent is
doing most of the work, which is the assumption VS Code was never built for.

The things that make VS Code good — editor, git diffs, worktree view, integrated
terminal — but arranged around watching, steering, and correcting an agent.

**Nothing like this exists.** So the strategy is: build correct building blocks
first, then compose a custom app on top of them.

### The core insight

VS Code assumes a human types the code and occasionally asks for help. This app
assumes an agent writes the code and the human reviews, steers, and unblocks.
That inverts what deserves screen space: the diff of what just changed, which
agents are running, what context the agent is carrying, what it is about to do.

## Principles

1. **Panes hold anything.** A pane is a generic container. Its content may be a
   shell, a `claude` session, a diff, a git tree, an editor, a log. Not a fixed
   set of named tabs.
2. **Layout is the user's.** Split, drag, resize, close. The app ships a default
   arrangement and never dictates one.
3. **Claude Code runs unmodified.** Real `claude` in a real PTY, full TUI, all
   slash commands, plan mode. The app wraps it; it does not reimplement it.
4. **Easy path before hard path.** "Open this exact file at this line in VS
   Code" ships long before an in-app editor. The escape hatch stays forever.
5. **Blocks before features.** Each phase produces a foundation the next phase
   composes, not a demo.

## Verified stack

Probed end to end before writing this, not assumed:

| Piece | Version | Verified |
|---|---|---|
| Electron | 41.7.1 | window + IPC |
| @xterm/xterm | 6.0.0 | renders; `term.buffer.active` populated |
| node-pty | 1.1.0 | real PTY, bidirectional (`MARKER-42` round-trip) |
| `claude` in a pane | 2.1.261 | trust dialog + `╭─── Claude Code` frame rendered |

**Two gotchas already paid for:**
- `node-pty` needs `npx @electron/rebuild -f -w node-pty` after install — the
  npm package ships only Windows prebuilds.
- `ELECTRON_RUN_AS_NODE=1` is set in this environment. With it set, Electron
  runs `main.js` as plain Node and `require("electron")` returns a path string,
  so `app` is undefined. The launcher must clear it.

**Rejected:** Bun. `node-pty` spawns but its data callbacks never fire under
Bun — silently, no error. Node only.

## Building blocks

Layered so each is independently testable and the ones above compose them.

```
┌─ app shell ────────────────────────────────────────────┐
│  window · tabs · command palette · keymap              │
├─ layout engine ────────────────────────────────────────┤
│  split tree · drag-resize · focus · persist/restore     │
├─ pane kinds ───────────────────────────────────────────┤
│  terminal │ claude │ diff │ git tree │ editor │ agents  │
├─ services (main process) ──────────────────────────────┤
│  pty · git · fs/watch · claude-session · config        │
└─────────────────────────────────────────────────────────┘
```

### 1. PTY service
Spawn, write, resize, kill. One PTY per terminal pane, surviving pane moves.
Scrollback retained on the main-process side so a moved pane does not lose it.

### 2. Layout engine
A binary split tree (`{dir, ratio, a, b}` | `{paneId}`). Drag a border to change
`ratio`; drag a tab to re-parent a node. Serializes to JSON, so layouts restore
on launch and become named workspaces later.

### 3. Pane registry
A pane kind declares: an id, how to render, what it needs on mount, and how it
serializes. Adding a kind later touches nothing else — that is the point of
doing this before features.

### 4. Claude session service
Detects which PTYs are `claude`, resolves each to its session id and transcript,
and exposes tokens / agent tree / model. **This is where the salvaged code
lands** — it already works and is tested.

### 5. Git service
`status`, `diff`, `log --graph`, `worktree list`, and a file watcher. Feeds the
diff and tree panes. Read-only in v1.

## What survives from the previous build

26 files of UI-free logic, verified to import no UI library, parked in
`/private/tmp/th-salvage`, with 14 test files:

| Module | What it does | Was proven against |
|---|---|---|
| `data/transcript.ts` | tolerant JSONL reader | 4,699 lines, 0 skipped |
| `data/agentTree.ts` | subagent DAG via `parent_tool_use_id` + `.meta.json` join | 91 nodes, 0 orphans |
| `data/usage.ts` | token/cost from `modelUsage` (not `usage` — it omits subagents) | live session |
| `data/config/*` | skills by cost-per-use, memory, MCP, atomic settings writer | 57 skills / ~5,921 tok |
| `proxy/*` | reverse proxy: wire capture + provider routing | 670 KB request captured |

Everything visual is gone. That was roughly two thirds of the previous build.

## Phases

Each ends in something you can open and use.

### Phase 1 — Panes + PTY *(the foundation)*
The app window, split panes you drag and resize with a mouse, tabs you move
between, and terminals that hold anything — including `claude` with its real UI
intact. Layout persists across restarts.

Done when: you can run your normal Claude Code workflow in this app instead of
iTerm+tmux and not miss anything.

### Phase 2 — Git surface
Diff pane (what the agent just changed), branch/worktree tree, status.
Click a file → **opens in VS Code at that line** (the easy path).

Done when: you review an agent's work without leaving the app.

### Phase 3 — AI layer
Port the salvaged services. Agent tree and timeline, live tokens, the
cost-per-use skills browser, memory and MCP.

Done when: you can see what the agent is doing and what context it carries.

### Phase 4 — Editor (the hard path)
In-app editing via Monaco. "Open in VS Code" stays.

### Phase 5 — Custom to you
Whatever the first four phases reveal you actually want. Deliberately unplanned.

## Risks

- **Electron + native modules.** Already paid once with `@electron/rebuild`;
  will recur on every Electron upgrade. Pin versions, document the rebuild.
- **Layout engines are deceptively hard.** Drag-resize and drag-to-reparent are
  where this kind of app usually dies. Phase 1 is deliberately only this.
- **`claude` inside xterm.js.** Renders correctly in the probe; needs testing
  against resize, mouse mode, and bracketed paste.
- **Scope.** Phase 4 is where this could become a lifetime project. The VS Code
  escape hatch exists so that it does not have to.

## Verification

- **Phase 1:** run a full day's work in it. Split a pane while `claude` is
  mid-turn and confirm nothing is lost; restart and confirm layout returns.
- **Phase 2:** have an agent change 3+ files, review every diff in-app, jump one
  to VS Code at the right line.
- **Phase 3:** run a prompt fanning out 3+ subagents; the tree must match the
  raw `agent-*.jsonl` files.
- **Ongoing:** it replaces iTerm+tmux for real work, or it has failed.
