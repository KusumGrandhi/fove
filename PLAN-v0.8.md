# fove v0.8 — the loop, not the surface

v0.5 made fove a real app. v0.7 made it a daily driver: you can create a file,
step through code, see the page you are changing, and switch worktrees without
hunting.

v0.8 is a different kind of round. The panes exist; what is missing is the
**loop between them** — an agent finishes and you review its work file by file,
a test fails and you start a debugger by hand, you save and alt-tab to reload.
Each of these is two features that already exist and no wire between them.

Grounded against this machine. Findings marked **[verified]** were checked
today, and several killed items that looked worth doing.

---

## 0. Closed — do not build

**The 32 auto-installed agents.** v0.7 deferred an audit of whether their
descriptions load into every system prompt. The premise is gone:
`~/.claude/agents/` **does not exist**, and `agentLastUsed` in `~/.claude.json`
has exactly **one** entry (`bg`). **[verified]** There is no context being paid
for and not chosen. Close the item.

**Skills, mostly.** 57 skill directories exist, but `skillUsage` has only 23
entries **[verified]**, and you have already said skill authoring belongs to the
harness. The config browser already lists them. Nothing further here until you
say a specific skill is misbehaving.

**A general test-runner pane.** `core` collects **8,557 tests in 5.5s**
**[verified]**. A pane that runs "the tests" is useless at that size — you would
never press it. What is useful is narrower, and appears as §2 below.

---

## 1. What changed while I was away

**The highest-value item on this list**, and the only one that is genuinely
about how you work rather than about a missing button.

An agent runs for ten minutes and touches nine files. Today you review that in
the git pane, file by file, with no record of which turn produced what. The
question you actually have is *"what did it just do, and is any of it wrong?"*

fove already holds both halves: `gitWrite.ts` produces diffs, and the agent
tree knows when each turn started and ended.

**What ships:**
- A **turn boundary marker**: snapshot `git status` when a turn starts, diff
  against it when the turn ends.
- One reviewable diff of everything that turn touched, in one scroll.
- Per-file **accept / revert**, so a bad edit is one click rather than a manual
  `git checkout`.
- Ordering by risk, not alphabet: new files and deletions first, then large
  diffs, then one-line changes.

**The honest risk:** you edit files too, and so does a background agent in
another worktree. Attributing a change to a turn is a heuristic, not a fact.
The UI must say "changed during this turn", never "the agent did this" — and
must be per-worktree so a session in `curitiba` cannot contaminate `core`.

---

## 2. From a failing test to a debugger, in one click

The debugger works **[verified end to end against debugpy 1.8.21]** — but
starting one still means choosing a config, choosing an interpreter, and
setting a breakpoint by hand. The most common reason to debug is a failing
test, and that path is entirely manual.

**Not a test-runner pane.** Given 8,557 tests, the unit of work is *one test*
or *one file*:

- **Run the test under the cursor** — from the editor, `pytest path::test_name`.
- Failures as a list; click to jump to the failing line.
- **Debug this test**: same invocation under debugpy, with a breakpoint set at
  the failure line automatically.

**[verified]** `core` has `pytest.ini` and `pytest.integration.ini`, so the
invocation is discoverable rather than guessed. `pytest 9.0.3` is present in
`aipenv`.

**Precondition to state plainly:** `aipenv` — the 3.10 env matching `core`'s
Flask config — **still has no debugpy**. `base` and `aipenv-new` have it.
Either install it there, or this feature only works in the other envs.

---

## 3. Browser auto-reload on save

Named in the v0.7 plan as the thing that makes a browser pane worth having next
to an editor, and **not built**. The pane can already `reload(paneId, hard)`;
what is missing is the trigger.

The file watcher exists (`watch.ts`). Wire: save → debounce → reload.

Small, and it closes a loop that is currently an alt-tab. Worth doing early
because it is an hour, not a day.

---

## 4. Agent cost per turn

The rail tracks the right session now, but shows **cumulative** tokens. A
single expensive prompt is invisible inside a 419M total.

Per-turn cost makes "that prompt cost 40k" obvious immediately. The accounting
already exists in `usage.ts`; this is a display change plus a turn boundary —
**the same boundary §1 needs**, which is the argument for doing them together.

---

## 5. Smaller, if there is room

**a. Per-hunk staging.** `applyPatch` exists in `gitWrite.ts` and the diff view
already renders hunks **[verified]**, but there is no stage-this-hunk control.
The pieces are there; it is a button and a patch slice.

**b. Startup time.** The renderer is a single **4.3MB** chunk **[verified]**,
almost entirely Monaco. Code-splitting the editor would cut cold start. Only
worth doing if launch actually feels slow to you — measure before optimising.

**c. Command palette: files and sessions.** ⌘O covers worktrees and commands.
Adding file search and session switching is mechanical now that the palette
exists.

**d. Conditional breakpoints.** Explicitly out of scope in v0.7. Cheap now that
DAP works — `setBreakpoints` already takes a `condition` field.

---

## Order (proposed, not decided)

1. **Browser auto-reload** (§3) — an hour, closes a daily loop.
2. **Turn boundary + cost per turn** (§4) — small, and it is the foundation §1
   needs.
3. **What changed while I was away** (§1) — the flagship. Build it on the
   boundary from step 2.
4. **Test → debugger** (§2) — largest, and it depends on nothing above.
5. Whatever in §5 still looks worth it.

The checkpoint that matters: after §1 lands, use it on a real agent turn in
`core` before starting §2. §1 is a judgement call about attribution, and only
real use will say whether the heuristic is honest enough.

---

## Carried forward, still true

- Never test against real repos; disposable fixtures only.
- `~/.claude.json` is read-only, permanently.
- Prove tricky logic as a pure module before wiring a UI.
- **Verify against the running app, not just tests.** v0.7's sharpest bug — the
  `attach` deadlock — passed every unit test and appeared only against real
  debugpy, because the fake adapter replied immediately where the real one does
  not. A fake proves the shape, never the contract.
- Check *which directory* a "not found" came from before calling it a bug. Two
  false alarms in v0.7 were the right answer to the wrong question.
