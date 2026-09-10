# fove

**Fully Open Vibe-coding Environment** · v1.0

A terminal-first workspace for coding with agents. Panes hold anything — a
shell, a `claude` session, a git surface, an editor, a file search, a config
browser, an agent tree, a debugger, a browser. Layout is yours: split, drag,
resize, pin, persist.

Claude Code runs unmodified inside it, and fove registers itself as Claude's
IDE, so files and diffs it opens land in fove's own editor rather than
somewhere else.

fove is a shell around real command-line tools rather than a reimplementation
of them: a claude pane is the real `claude`, the git pane is real `git`, a
teammate tab is a real tmux pane. **File → Setup Check…** in the menu bar says
what is installed and offers to fix what Homebrew can.

See [PLAN.md](PLAN.md) for the architecture, and the per-release plans for
how it got here: [v0.5](PLAN-v0.5.md), [v0.7](PLAN-v0.7.md), [v0.8](PLAN-v0.8.md),
[v0.9](PLAN-v0.9.md), [v0.10](PLAN-v0.10.md).

## Requirements

macOS on Apple silicon. `node-pty` is compiled, so there is no x86 build.

| | | |
|---|---|---|
| `claude` | required | every claude pane — the app's reason to exist |
| `git` | required | the git pane, worktrees, diffs, commit graph |
| `tmux` | feature | teammate tabs; without it a swarm is never detected |
| `rg` | feature | the search pane |
| `code` | optional | the "open in VS Code" buttons |

The list lives in [`src/shared/deps.ts`](src/shared/deps.ts); the Setup Check
dialog and `scripts/bootstrap.sh` both read it, so it cannot drift.

## Run

```bash
./scripts/bootstrap.sh   # check tools, brew what it can, build, install
```

That is the first-run path: it verifies macOS and arch, installs missing
dependencies Homebrew can provide, refuses to build while a *required* tool is
missing, then runs `npm ci`, the typecheck, and `install:local`. Pass
`--check` to report without changing anything.

By hand:

```bash
npm install          # postinstall rebuilds node-pty for Electron's ABI
npm run dev          # build + launch
```

## Install as an app

```bash
npm run install:local   # build, sign ad-hoc, copy to /Applications
```

`npm run dist` additionally produces `release/fove-<version>-arm64.dmg`.

**Launching it.** Double-click it in Finder, or open it from Spotlight or the
Applications folder, like any other app. It is signed ad-hoc rather than with
an Apple Developer ID, so a copy *downloaded* to another machine would be
quarantined and need right-click -> Open; a locally built one is not.

**A Finder launch has no working directory.** A double-clicked macOS app
inherits `/`, which would open a workspace on the filesystem root. fove falls
back to the last workspace it had open, then to `$HOME` — see
[`src/shared/launch-cwd.ts`](src/shared/launch-cwd.ts).

**A debugging note worth keeping.** An automated agent running in a sandboxed
shell cannot launch this app with `open` -- every Electron app fails there with

    codesign_util.cc: task_name_for_pid: (os/kern) failure (5)

and dies before `main.js` runs. Stock Electron fails identically, so this is a
property of the sandbox, not of fove or its signature. Non-Electron apps
(Calculator) launch fine from the same shell, which makes it easy to
misdiagnose as an app bug. To launch it from such a context, go through the
user's own login session instead:

```bash
osascript -e 'tell application "Finder" to open POSIX file "/Applications/fove.app"'
```

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
├─ toolbar ── AI ▾ · Dev ▾ · Workspace ▾ ──────────┤
├──────────────────────────────────────────────────┤
│  ┌─ workspace ────────────────────────────────┐  │
│  │ ┌ ⎇ git ──┐┌ ✎ editor ─────┐┌ ✳ claude ─┐ │  │
│  │ │         ││               ││           │ │  │
│  │ │         │└───────────────┘│           │ │  │
│  │ │         │┌ ❯ shell ──────┐│           │ │  │
│  │ │         ││               ││           │ │  │
│  │ └─────────┘└───────────────┘└───────────┘ │  │
│  └────────────────────────────────────────────┘  │
├─ status bar ── 3 panes · 1 workspace ────────────┤
└──────────────────────────────────────────────────┘
```

**The toolbar is three hover menus** rather than fifteen buttons: **AI**
(claude, agents, Keel), **Dev** (git, editor, search, debug, browser) and
**Workspace** (splits, layouts, theme, close). They open on hover and close on
a short grace period, so crossing the gap to a submenu does not dismiss them.
Theme is a submenu of the five themes, ticked to show the current one.

**A tab is a workspace: one directory, with panes inside it.** Every pane in a
tab — shell, claude, git, editor, agents — uses that tab's directory, so they
are all looking at the same checkout. Since a git worktree is just another
directory, "tab per worktree" and "tab per project" are the same feature: the
⎇ picker in the toolbar opens any sibling worktree as its own workspace.

The app starts with exactly one workspace, the folder it was launched from.

**Most panes are singletons.** git, editor, search, config, browser, agents and
debug each exist at most once per workspace — asking for one again focuses the
one already open instead of splitting the layout further. Only `shell` and
`claude` are unlimited, because those are the panes you genuinely want several
of. ⌘D and the explicit Split actions still force a new pane regardless.

**Layout presets** are in the Workspace menu: *lite* (a shell and a claude),
*dev* (git column, editor over shell, claude on the right) and *agent* (built
around the agent tree). Picking one replaces the current workspace's layout.

**Pin a workspace** with its ○ icon, right-click, or `⌘⇧P`. Pinned tabs hold the
front of the bar in the order pinned, and nothing unpinned can displace them —
new tabs land after the pinned block, and closing a tab never reorders the rest.

**Drag a pane by its ⠿ header** to move it. Dropping near an edge splits that
pane (left/right/top/bottom); dropping in the middle swaps the two. A blue
overlay previews exactly where it will land, amber for a swap.

**Dividers stop at a minimum.** A pane cannot be dragged below 260px, so a
divider can no longer reduce a neighbour to an unusable sliver — see
`MIN_PANE_PX` in [`src/shared/layout.ts`](src/shared/layout.ts). A branch too
small to give both sides that minimum falls back to a proportional clamp rather
than freezing the divider.

**The git pane works in a slim column.** Below 520px the diff stacks under the
file list instead of beside it, and every file row carries its own `+`/`−` so
staging is per-file rather than all-or-nothing. The graph, stash and worktree
tabs sit *below* the changes list, and clicking the open tab closes it again.

## Keys

| | |
|---|---|
| `⌘O` | command palette |
| `⌘↵` | claude pane |
| `⌘J` | claude pane, split down |
| `⌘G` | git status + diff |
| `⌘E` | file editor |
| `⌘R` | subagent tree + timeline |
| `⌘K` | config browser |
| `⌘B` | browser pane |
| `⌘⇧F` | search |
| `⌘M` | model picker |
| `⌘D` | split right |
| `⌘⇧D` | split down |
| `⌘S` | save the focused editor |
| `⌘W` | close pane |
| `⌘T` | open a folder as a new workspace |
| `⌘P` | pin / unpin the focused pane |
| `⌘⇧P` | pin / unpin the active workspace |
| `⌘1..9` | switch tab |

The pane keys focus an existing singleton rather than splitting again. `⌘S` is
handled by the editor itself, so it only fires when an editor has focus.

`⌘L` (Keel) is currently unbound — the feature is Alpha and is reachable from
the ⌘O palette, where it is badged as such.

Drag a divider to resize. Click a pane to focus it.

## Layers

```
app shell      tabs · keymap · menus         src/renderer/App.tsx
layout engine  split tree · geometry         src/shared/layout.ts   (pure, tested)
pane kinds     shell · claude · git ·        src/renderer/panes/
               editor · agents · config ·
               search · browser · debug
services       pty · git · teams · doctor    src/main/
pure logic     layout · git-parse · deps ·   src/shared/           (pure, tested)
               tree-rows · launch-cwd
```

**Everything interesting lives in `src/shared/` and has no React and no
Electron in it**, which is why 749 tests across 52 files can cover it without
launching an app: `layout.ts` (splitting, closing, resizing, re-parenting),
`git-parse.ts` (every shape git can emit), `tree-rows.ts` (the editor tree's
flatten and reveal), `deps.ts` (what the machine needs) and `launch-cwd.ts`
(which folder a workspace opens in).

`src/shared/git-parse.ts` is likewise pure string -> data, so every shape git
can emit (renames, spaces in filenames, unmerged, detached HEAD, binary) is
tested without a repository. Porcelain v2 with `-z` is used deliberately: it is
the only form that survives filenames containing spaces or newlines.


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
unless clicked.

**A teammate tab is a real terminal, one agent per tab.** Opening one runs
`tmux attach` against that teammate's own window, so you type directly into
that `claude` — no snapshot, no one-line input box. Since `attach` targets a
*window* rather than a pane, the tab first `break-pane -d`s the teammate into
its own window and `join-pane -d`s it back on close, which is what keeps one
tab from showing every teammate's output at once.

`capture-pane` is still used for the read-only preview in the agents pane, with
`-J` so a wrapped line arrives whole — without it a 120-character line comes
back as 43.

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
