# fove v0.8 — what it actually became

**Status: shipped.** This document was rewritten after the fact to describe
what landed, because what landed was not what was planned. The original plan is
in git history (`e41610d`); the divergence is the interesting part and is
recorded in §3 rather than quietly edited away.

---

## 1. What shipped

Four changes, none of them on the original list. Every one came from using the
app and pointing at something wrong, which is the process the original plan
asked for in its own closing line — *"use it on a real turn before starting the
next thing"* — even though it is not the work that plan predicted.

### Commit diffs in the git pane

Clicking a commit in the graph expands it into the files it changed, each
expandable to its own diff, with `open` to jump into the editor.

The backend already existed. What did not was correct handling of the two
commit shapes where the obvious command is **silently wrong**: `git diff
<sha>^!` exits 0 and prints nothing for both a root commit and a merge, which
renders as "this commit changed no files". Roots now use `show` against the
empty tree; merges use an explicit first-parent diff and are **labelled as
such**, because showing one parent's view of a merge without saying so is
lying by omission. Both verified against disposable fixtures.

### A readable commit graph

Git's default order is reverse-chronological, so on a repository where many
branches move on the same day it interleaves them commit by commit and every
lane in the drawn graph zigzags. **[verified]** on `core`: 58% of rows broke
their lane by date, 26% by topology. `--topo-order` fixes it.

Two smaller findings on the same pass, both **[verified]**:

- `--all` pulls in `refs/stash`, and each stash contributes up to three commits.
  With 53 stashes that buried the newest real work under bookkeeping.
  `--exclude=refs/stash` does *not* remove them; dropping `--all` for
  `--branches --remotes --tags` does.
- Dropping `--all` loses a detached HEAD — the commit you are sitting on —
  which worktrees produce routinely. `HEAD` is now passed explicitly.

Plus a `this branch` / `all branches` toggle, defaulting to the branch, because
the full view buried HEAD 43 rows down among other people's work.

### Starting layouts

Every new workspace opened as a single shell. Three presets — **Lite**
(Claude + shell), **Agent** (Claude + subagents + git), **Dev** (editor + git +
shell, Claude alongside) — in the toolbar and the palette, sticky across tabs.

They are starting points, not modes. The moment a pane is dragged, the preset
stops being a fact about the tab.

The part that needed care: switching a layout **reuses** open panes rather than
rebuilding them. A `claude` pane holds a live session and a `shell` holds a PTY
with real history; rebuilding those to satisfy a layout would destroy work in
order to tidy the furniture. Verified in the running app by pane identity, not
by inspection. The reuse logic lives in `planPresetApply` as a pure function
precisely so it can be proved.

### A stats rail that gets out of the way

Collapses to a 26px spine, starts collapsed, remembers the choice. 260px of
permanent width was a lot for two cards glanced at occasionally.

Collapsing also stops the polling behind it — which was **not true when first
written**. `useSnapshot` polled every 2.5s regardless of its `cwd` argument, so
the guard did nothing. Measured from the main process rather than trusted: 0
polls in 8s collapsed, 3 expanded.

**425 → 455 tests.**

---

## 2. Still open, carried to v0.9

From the original plan, unbuilt:

- **Browser auto-reload on save** — the watcher and `reload()` both exist; only
  the trigger is missing. Roughly an hour. The most likely thing to pick up
  next, because it closes a daily alt-tab.
- **Turn boundary + cost per turn** — deliberately deferred. It is the
  foundation v0.9 needs (see `PLAN-v0.9.md` §2), and it belongs with the work
  that consumes it rather than shipped in isolation.
- **"What changed while I was away"** — the original flagship. Now the core of
  Keel in v0.9, which is a better home for it than the git pane.
- **Test → debugger in one click** — unblocked and independent. Still worth
  doing. **Precondition unchanged:** `aipenv`, the 3.10 env matching `core`'s
  Flask config, still has no `debugpy`; `base` and `aipenv-new` do.
- **§5 smaller items** — per-hunk staging, code-splitting (4.3MB single chunk),
  palette files+sessions, conditional breakpoints.

---

## 3. Why the plan and the release diverged

Worth recording rather than tidying away, because it is a fact about how this
project actually works.

The plan ranked items by reasoning about the codebase. The four that shipped
were all found by **looking at the running app** — a graph that was hard to
read, a commit that would not open, a workspace that started empty, a rail
eating a quarter of the width. None were visible from the code.

Three of the four also turned out to be hiding a defect that no test would have
caught: two silently-empty git commands, a polling guard that did not guard, and
a set of lane colours so muted they were invisible against the ground. The
original plan's own closing note — *verify against the running app, not just
tests* — is the rule that produced this release.

The lesson is not that plans are useless. It is that **a plan's ordering is a
hypothesis, and use is the experiment.** v0.9 is written the same way and should
be expected to survive contact about as well.

---

## 4. Closed by evidence — do not revisit

Both **[verified]** during v0.8 planning and still true:

- **The "32 auto-installed agents" audit.** `~/.claude/agents/` does not exist,
  and `agentLastUsed` has exactly one entry. There is no context being paid for
  and not chosen.
- **A general test-runner pane.** `core` collects 8,557 tests in 5.5s. A pane
  that runs "the tests" is one you would never press. The useful version is
  narrower and is the test→debugger item above.

---

## Carried forward, still true

- Never test against real repos; disposable fixtures only.
- `~/.claude.json` is read-only, permanently.
- Prove tricky logic as a pure module before wiring a UI.
- **Verify against the running app, not just tests.** Three of this release's
  four items proved it again.
- Check *which directory* a "not found" came from before calling it a bug.
