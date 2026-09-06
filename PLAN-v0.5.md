# fove v0.5 — plan

Captured from a v0.1 wrap-up conversation. v0.1 shipped: panes + PTY, layout
engine, read-only git, the AI layer (agents / teammates / background sessions),
Monaco editor, the Claude Code IDE integration, and a macOS bundle.

This is a **plan, not a design doc**. Where something was actually verified
during v0.1 it says so; where it is still an assumption it says that too, so
nobody rediscovers the same dead ends.

---

## 0. Launch blocker — RESOLVED, was never a real bug

**Outcome: there was nothing wrong with the app.** fove launches correctly by
double-click, from Spotlight, and from the Applications folder. Verified: 4
processes, window present, IDE server answering `tools/list`.

**What actually happened.** Every test of "double-click" was run from an
automated agent's *sandboxed shell*, where `open` cannot launch any Electron
app. It fails before `main.js` runs with:

    codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)

The control that settled it: **stock Electron** (`node_modules/electron/dist/
Electron.app`), untouched, fails identically from that shell -- while
Calculator launches fine, and VS Code runs happily with 24 processes. So the
failure tracks the launching context, not the app or its signature.

To launch it from such a context, hand the launch to the user's login session:

```bash
osascript -e 'tell application "Finder" to open POSIX file "/Applications/fove.app"'
```

**The mistakes worth remembering**, since both cost real time:

- Gatekeeper was asserted as the cause on the strength of `spctl -a` saying
  `rejected`, while **no `syspolicyd` denial was ever logged** -- the evidence
  that contradicted the theory was visible and went unweighed. An Apple
  Developer ID would have been bought to fix a non-problem.
- Several "it doesn't launch" results were the *test harness* failing, not the
  app: `timeout` missing from a stripped `PATH`, `spawnSync` holding the
  pipeline so backgrounding killed the child, and Chromium flags
  (`--remote-debugging-port`) being rejected outright under
  `ELECTRON_RUN_AS_NODE`.

**The lesson for the rest of this plan:** when something fails only under
instrumentation, test the instrument before concluding anything about the
product. A control case (does a *stock* build fail the same way?) costs one
command and would have ended this in minutes.

Still genuinely true and worth keeping:
- `ELECTRON_RUN_AS_NODE` is set in this user's login environment, and the
  re-exec guard in `main.ts` is what makes a double-clicked `.app` survive it.
- Signing stays ad-hoc. A copy *downloaded* to another machine is quarantined
  and needs right-click -> Open; distribution would need a Developer ID.

## 1. Icon

fove currently ships the default Electron icon.

- Need `build/icon.icns` (1024×1024 source, all sizes via `iconutil`).
- Wire through `build.mac.icon` in `package.json`.
- Also set the in-app title-bar mark so the window matches the dock.

Small, self-contained, and makes the app feel real. Good first task.

---

## 2. Git: from read-only to a working surface

**Today (v0.1):** `status`, `worktrees`, `diff`, `untracked-diff`, `log`,
`root`. All read-only. Parsing is porcelain v2 with `-z` NUL separation, which
is the only form that survives filenames with spaces and newlines — keep that
discipline for every new command.

**To build:**

| Feature | Notes |
|---|---|
| **Git tree / graph** | `log --graph` is already piped but not visualised. Needs a commit-DAG layout (lanes, merges) — this is the hardest piece, treat it as its own block like the layout engine was. |
| **Stage / unstage** | Per-file and per-hunk. Hunk staging needs `apply --cached` with a generated patch; get file-level working first. |
| **Commit** | Message box, amend, and the pre-commit hook path (hooks can fail — surface the output, never swallow it). |
| **Push / pull** | Needs credentials and can prompt. Must never block the UI thread, and must show real remote errors verbatim. |
| **Stash** | push/pop/list/drop, including untracked. |
| **Blame** | `blame --porcelain`, rendered as an editor gutter. Pairs naturally with Monaco; click a line → that commit. |

**The one hard rule carried from v0.1:** *never interact with the user's real
repos during testing.* All git work is verified against a disposable fixture in
the scratchpad. This was an explicit instruction and it still stands.

**Write operations change the risk profile.** Everything so far has been
read-only; `push`, `commit --amend`, and `stash drop` can lose work. Each write
command needs a confirmation path and an explicit statement of what it will do
before it does it.

---

## 3. Stats panel — the numbers are wrong

**Root cause is identified and confirmed against a real transcript.**

The panel showed `input 20 · output 0 · cache read 450.1k`. Output being 0 for
a session that plainly produced output is the tell.

- `usage.ts` takes whole-tree totals from `modelUsage`, which is correct for
  the **SDK**, and deliberately treats per-step `output_tokens` as a
  placeholder to be corrected later by `addResult()`.
- But **CLI transcripts contain no result record**: `modelUsage` appears
  **0 times** in a real `~/.claude/projects/**.jsonl`. So `addResult()` never
  fires, `wholeTree` stays `false`, and output tokens are never counted at all.
- `addStep()` even documents this case ("historical replay of transcripts that
  have no result record") but does not handle it.

**The fix, and its trap:** count `output_tokens` in `addStep()` — but only
under the existing `seenMessageIds` dedup. Output repeats per message id in the
transcript (994 appeared 3×, 1016 twice in the sample), so naive summing
over-counts. The dedup mechanism already exists; it simply is not applied to
output.

Also worth doing while in here:
- Mark the readout when `wholeTree === false`, so a main-loop-only number is
  never silently presented as a whole-tree total.
- Re-check the cache-hit denominator against the corrected figures.

---

## 4. The AI development package

This is the largest item and should be split. The stated goal: *"an easy and
best way to develop without me needing to interfere."*

**The governing constraint, in the user's words:** *only implement what is not
already in Claude Code natively and easily.* Before building anything in this
section, check whether the CLI already does it — v0.1 wasted effort twice by
rebuilding things that existed.

Candidates, roughly in dependency order:

- **Easy DB access** — a pane that connects, browses schema, runs queries.
  Decide early: is this for the app's own use, or a surface Claude can drive?
- **Debugger** — the biggest single item here. Node/Python DAP is a project in
  itself. Consider scoping to one language for v0.5.
- **Browser testing** — a controllable browser view with results Claude can
  read. Overlaps with existing MCP/Playwright options; check first.
- **Personalized agents** — a UI over agent definitions. Claude Code already
  has subagents and teammates; the gap is *authoring* and *reusing* them.
- **MCP integration, done better** — v0.1 ported an MCP config reader but never
  built a UI. There is real value here: status, per-tab enable/disable, and the
  OAuth-needed connectors listed with links out.
- **Skills** — explicitly deferrable to **0.9**. The cost-per-use skills
  browser is ported and tested but has no UI.

**Recommendation:** pick MCP + personalized agents for v0.5 (both build
directly on what exists), and defer the debugger and browser testing to 0.7+.
They are each larger than everything else on this list combined.

---

## 5. Themes, animation, friendlier UI

- Theme tokens rather than the hard-coded hex values currently scattered
  through the panes (`C` in `Chrome.tsx` is a start; Monaco has its own
  `th-dark` theme that must stay in sync).
- Motion on pane split/close/drag, and on the diff overlay.
- Keep the "don't distract me" principle from v0.1: the teammate bar renders
  *nothing* when no swarm is running. Animation must not violate that.

---

## 6. OpenRouter / model switching

Goal: switch models easily from inside fove's Claude Code panes.

**What already exists, ported and tested, with no UI:**
`src/data/models/thirdParty.ts` and `src/proxy/server.ts` (a local reverse
proxy that can re-point upstream and swap the auth header).

**The mechanism, from the original research:**
- Same-provider switches (Opus ↔ Sonnet ↔ Haiku) are live.
- Cross-provider switches normally require a restart, because
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are read at client
  construction. **Routing through the local proxy avoids the restart** — that
  is the whole reason the proxy exists.

**Add OpenRouter as a provider entry** alongside the already-verified Moonshot
/ Zhipu / DeepSeek endpoints.

**Warn honestly in the UI.** Anthropic does not support routing Claude Code to
non-Claude models. In practice: prompt caching usually does not apply (cost and
latency get *worse*), extended thinking is often absent, and tool-call
formatting diverges — which shows up as the agentic loop stalling or looping.
Token accounting becomes unreliable, so the cost display must be suppressed or
clearly marked when a third-party model is active.

Config belongs in a fove-owned file (`~/.config/fove/providers.json`, mode
0600), **never** in `~/.claude.json` or `~/.claude/settings.json`, so a bad
entry cannot break the plain CLI.

---

## Suggested order

1. ~~**Launch blocker** (§0)~~ — resolved; was a sandboxed-shell artifact, not
   an app defect.
2. **Stats fix** (§3) — root cause known, small, and it is currently lying to
   the user.
3. **Icon** (§1) — small, visible, self-contained.
4. **Git write operations** (§2) — staged: stage/commit → stash → push →
   blame → graph last.
5. **OpenRouter** (§6) — the machinery exists; this is mostly UI plus a
   provider entry.
6. **MCP + personalized agents** (§4) — the two AI-package items that build on
   what is already there.
7. **Themes / animation** (§5) — best done once the new surfaces exist, or it
   gets redone.

Deferred to 0.7+: debugger, browser testing. Deferred to 0.9: skills UI.

---

## Carried-over rules

- **Never touch the user's real git repos** when testing. Disposable fixtures
  in the scratchpad only.
- **`~/.claude.json` is read-only, permanently.** It holds live credentials.
  Writes go to `~/.claude/settings.json` instead.
- **Build blocks before features.** The layout engine and git parser were
  proven in isolation first, and both worked immediately when wired up. The
  commit-graph and hunk-staging work deserves the same treatment.
- **Verify against the running app, not just tests.** Several v0.1 bugs (the
  `mcp` subprotocol, the missing `openDiff` listener, the unreported selection)
  passed every unit test and only appeared when driving the real thing.
