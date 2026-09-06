# fove

An AI-optimized developer app. Panes hold anything — a shell, a `claude`
session, and later a diff, a git tree, an editor. Layout is yours: split,
drag, resize, persist.

See [PLAN.md](PLAN.md) for the architecture and phases.

## Run

```bash
npm install          # postinstall rebuilds node-pty for Electron's ABI
npm run dev          # build + launch
```

## Install as an app

```bash
npm run install:local   # build, sign ad-hoc, copy to /Applications
npm run approve:local   # ONCE: tell Gatekeeper this app is allowed (needs sudo)
```

Then open fove from Spotlight or the Applications folder like any other app.
`npm run dist` additionally produces `release/fove-<version>-arm64.dmg`.

**Why the extra approval step.** The app is signed ad-hoc, not with a paid
Apple Developer ID. Running the binary directly always works, but launching it
by double-click goes through launchd, which asks Gatekeeper first -- and
Gatekeeper rejects anything without a Developer ID. `approve:local` registers a
local exception; a downloaded copy on someone else's machine would need
right-click -> Open, or a real signing identity.

Two packaging traps already paid for:

- **`ELECTRON_RUN_AS_NODE` in the user's login environment.** With it set,
  Electron runs `main.js` as plain Node and exits silently -- no window, no
  error. `npm start` clears it, but a double-clicked `.app` inherits it, so
  `main.ts` re-execs itself without the variable before importing electron.
  The re-exec must pass the app root explicitly: in a packaged app `argv` is
  just `[binary]`, so relaunching with the arguments alone starts Electron with
  nothing to run.
- **`node-pty` cannot load from inside an asar.** It ships a `.node` binary and
  a separate `spawn-helper` executable, so it is listed in `asarUnpack`.
  Everything else is bundled by Vite and excluded from `node_modules`, which
  took the archive from 117MB to 15MB (`monaco-editor` alone was 2,325 files).

## UI

```
┌─ title bar ─────────────────── tabs · + ─────────┐
├─ toolbar ── Split · Split down · Claude · Shell ·│
│             Git · New tab            Close pane  │
├──────────────────────────────────────────────────┤
│  ┌─ workspace ────────────────────────────────┐  │
│  │ ┌ ❯ shell ──────┐┌ ⎇ git ───────────────┐ │  │
│  │ │               ││                      │ │  │
│  │ └───────────────┘└──────────────────────┘ │  │
│  └────────────────────────────────────────────┘  │
│  ┌ ⠿ ❯ shell ────┐┌ ⠿ ⎇ git ──────┐  ┌ STATS ─┐  │
│  │               ││               │  │ widgets│  │
│  └───────────────┘└───────────────┘  └────────┘  │
├─ status bar ── 2 panes · tab 1 of 1 ─────────────┤
└──────────────────────────────────────────────────┘
```

**A tab is a workspace: one directory, with panes inside it.** Every pane in a
tab — shell, claude, git, editor, agents — uses that tab's directory, so they
are all looking at the same checkout. Since a git worktree is just another
directory, "tab per worktree" and "tab per project" are the same feature: the
⎇ picker in the toolbar opens any sibling worktree as its own workspace.

The app starts with exactly one workspace, the folder it was launched from.

**Pin a workspace** with its ○ icon, right-click, or `⌘⇧P`. Pinned tabs hold the
front of the bar in the order pinned, and nothing unpinned can displace them —
new tabs land after the pinned block, and closing a tab never reorders the rest.

Every shortcut is also a toolbar button, and every pane has its own ✕. The
panes sit inside a framed workspace rather than filling the window edge to edge.

**Drag a pane by its ⠿ header** to move it. Dropping near an edge splits that
pane (left/right/top/bottom); dropping in the middle swaps the two. A blue
overlay previews exactly where it will land, amber for a swap.

The **STATS rail** on the right is permanent and currently empty — it is where
widgets will live.

## Keys

| | |
|---|---|
| `⌘D` | split right |
| `⌘⇧D` | split down |
| `⌘↵` | split right, running `claude` |
| `⌘J` | split down, running `claude` |
| `⌘G` | split right, git status + diff |
| `⌘E` | split right, file editor |
| `⌘R` | split right, subagent tree + timeline |
| `⌘S` | save the focused editor |
| `⌘W` | close pane |
| `⌘T` | open a folder as a new workspace |
| `⌘⇧P` | pin / unpin the active workspace |
| `⌘1..9` | switch tab |

Drag a divider to resize. Click a pane to focus it.

## Layers

```
app shell      tabs · keymap                 src/renderer/App.tsx
layout engine  split tree · geometry         src/shared/layout.ts   (pure, tested)
pane kinds     terminal · git · editor ·      src/renderer/panes/
               agents
services       pty · store                   src/main/
```

`src/shared/git-parse.ts` is likewise pure string -> data, so every shape git
can emit (renames, spaces in filenames, unmerged, detached HEAD, binary) is
tested without a repository. Porcelain v2 with `-z` is used deliberately: it is
the only form that survives filenames containing spaces or newlines.

`src/shared/layout.ts` is deliberately free of React and Electron: splitting,
closing, resizing and re-parenting are where an app like this usually breaks,
so they are proven in isolation before any pixels exist.

## Notes for future me

**`node-pty` must be rebuilt for Electron** (`electron-rebuild -f -w node-pty`);
the npm package ships Windows-only prebuilds. This runs on `postinstall`.

**`ELECTRON_RUN_AS_NODE` must be unset.** With it set, Electron runs `main.js`
as plain Node, `require("electron")` returns a path string, and `app` is
undefined. `npm start` clears it.

**Bun does not work.** `node-pty` spawns but its data callbacks never fire —
silently, no error. Node only.

**The preload cannot import shared modules.** Electron loads it as a single
file with no module resolution, so channel names are duplicated in
`src/main/preload.ts`; `test/ipc-contract.test.ts` keeps the copy honest.

**Monaco workers need relative paths under Rolldown.** Vite's `?worker` suffix
does not resolve against a package's `exports` map, so the five Monaco workers
are imported via `../../../node_modules/monaco-editor/...`. Without them the
editor renders but every language feature silently does nothing.

**Editor languages come from Monaco's own registry**, not a hand-written map —
91 languages, and new ones arrive with a Monaco upgrade. A small table adds
what Monaco does not ship (Vue/Svelte → html, Haskell → fsharp) and the
extensionless names a registry lookup misses (Makefile, Gemfile, .env, dotfiles).

**Teammates are not subagents.** A Task subagent lives inside one transcript and
can only be read after the fact. A *teammate* is its own `claude` process in a
tmux pane, so it can be watched live, interrupted, and talked to. The app joins
`~/.claude/teams/<team>/config.json` (who exists, their prompt and pane id) with
the live tmux socket (what they are doing now).

They surface as a sub-tab bar that exists only while a swarm is running — it
appears when agents start, disappears when the last finishes, and opens nothing
unless clicked. `capture-pane` reads output; `send-keys` types into the pane.

**tmux does not pass a literal tab through `-F`** — it arrives as `_`, so a
format string using `\t` silently produces one unsplittable field. Fields use
a `|:|` separator instead.

**The AI layer reads what Claude Code already writes.** Sessions live in
`~/.claude/projects/<slug>/*.jsonl`, so the subagent tree, token totals and
model list need no hooks and no cooperation from the CLI. Subagent logs key on
a hex `agentId` while the main transcript keys the same agent by its `toolu_…`
tool_use id; the `agent-<id>.meta.json` sidecars join the two.

**Token totals come from `modelUsage`, never `usage`.** On a result message
`usage` counts only the top-level loop and omits every subagent token — for an
app built around subagents that would make every figure quietly wrong.

**Editor saves are guarded by mtime.** An agent editing the same file produces
a visible conflict instead of a silent overwrite — see `FileService.write`.

**Never start a PTY at a degenerate size.** A pane that has not been laid out
reports 0x0; a 2x2 pty makes a full-screen TUI draw one frame and wedge. PTYs
start at 80x24 and take the first real resize instead.
