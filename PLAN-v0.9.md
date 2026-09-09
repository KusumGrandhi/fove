# fove v0.9 — Keel, and the handoff loop

**Status: shipped.** Rewritten after the fact to describe what landed, the way
`PLAN-v0.8.md` was. The original plan is in git history (`8b4d20d`); where it
was wrong, §4 says so rather than editing the mistake away.

The release criterion was set before the work started and did not move:

> *when we are able to do a complete loop of I handoff a ticket to Keel and it
> is able to safely plan, execute, check for risk/bugs and then ready to Review
> state. That's when we publish 0.9*

That loop runs. §2 is the transcript of it running.

---

## 1. What shipped

### Keel, an overlay

You hand fove a task and watch it through Keel — layered **over** the panes,
dismissed with Escape, never replacing them. Panes keep running underneath:
nothing unmounts, no PTY dies, the agent does not pause. When Keel cannot tell
you enough, you close it and read the code.

It sits at z-index 50, below the palette and below Claude's blocking diff (both
60), so an approval Claude is waiting on always wins.

Four surfaces, built to the design handoff:

- **`2c` review** (872px) — what the last turn changed, file by file, with what
  is *known* separated from what *cannot be proven here*.
- **`4a` workspace** (250px │ 1fr │ 316px) — file cards with each file's
  extracted contract, its purpose, and the rail of risks and checks.
- **`2d` intents** — the repository's rules, owned by you, proposable by an
  agent but never editable by one.
- **The handoff rail** — ticket box → plan → gate → checks → ready.

### The handoff loop

`shared/handoff.ts` is a pure state machine, tested as rules rather than as a
happy path, because the phases *are* the safety story:

```
idle → planning → awaiting-approval → executing → checking → ready
```

Three properties it exists to enforce:

- **Planning cannot write.** The plan phase runs under `--permission-mode plan`.
  Verified against real `claude` by asking it to modify a file in a scratch
  repository and finding the file untouched — a proposal that edited files on
  the way to being proposed is not a proposal.
- **A plan is approved before it runs**, and a *revised* plan is unapproved
  again. An agent may propose a different plan, but the approval it was given
  was for the plan it had, and that approval does not transfer. This is the rule
  that stops an agent changing course quietly mid-execution.
- **The loop never ends at merged.** `ready` is terminal. There is no merge
  event, here or anywhere: Keel assembles evidence, and the judgment stays
  yours.

Execution runs under `acceptEdits`, not `bypassPermissions` — edits proceed,
but a shell command with consequences still stops. The plan was approved, not a
blank cheque.

### What the loop rests on

Built in order, each proved as a pure module before any UI touched it:

| Module | What it answers |
|---|---|
| `shared/turns.ts` | Where does one turn end and the next begin? |
| `shared/changeset.ts` | What moved on disk *during this turn*, versus what was already dirty? |
| `main/snapshots.ts` | What did the tree look like before the agent started? |
| `main/contract.ts` | What is this file's public surface? |
| `shared/worklist.ts` | What deserves attention first? |
| `shared/intents.ts` | Which rules must stay true, and did they? |

`--json-schema` is the single feature the whole loop rests on: it returns a
**validated, typed object** in `structured_output`, which makes a plan data
rather than prose to scrape. Checked against the installed CLI before being
designed around, not assumed from the help text — along with
`--permission-mode`, `--max-budget-usd`, and the `session_id` that lets later
phases resume the same conversation.

### Intents

A rule about the codebase, in English, that must stay true. Not what the code
does — that is documentation, and it rots — but what it must never stop doing.

They live in `~/.fove/intents/<identity>`, **not in the repository**, because
your rules are yours: *"my test and my rules should live with me, I cannot force
these onto a production repo ever."* Identity is the remote URL where one
exists, else `--git-common-dir`, so every worktree of a repository shares one
intent store.

Mechanisms come first and judgment second, and they are never merged into a
single "looks good": a mechanism is a search and gives a verdict that does not
depend on anyone's opinion; the review is a judgment and is labelled as one.

### The UI sweep that gated the release

Four reported problems, three of which were not what they looked like. Recorded
in `f55966c`; the short version:

- **Search** was answering the wrong question, not failing. It searched contents
  only, so a filename query found nothing. It searches names now.
- **The debugger worked.** The target app crashed on import because `core`'s
  `launch.json` sets no `ENVIRONMENT`; fove showed a bare `terminated` and
  dropped the reason, so the program's crash read as a broken debugger.
- **The editor popout** reset because `openPath` was only ever written by the
  palette route, so opening a file from the tree was invisible to the layout.
- **Panes overflowed** because a flex child with `overflow: auto` will not
  scroll without `min-height: 0`. Seven containers had that shape, including
  both Keel sheets.

Measured via CDP against the running app at four window sizes: the toolbar was
2007px wide in a 1440px window, the tab bar hid 567px. Now zero clipped
elements down to 760×520.

**455 → 621 tests.**

---

## 2. The loop, running

On a scratch Flask repository, through the UI, end to end. Not a rehearsal —
this is what the release criterion asked for.

**Plan** → `awaiting-approval`, 2 steps, 5 risks, working tree untouched. The
plan had read the repo's `AGENTS.md` and planned *around* it:

> *"AGENTS.md requires every route to declare its methods explicitly, so the
> decorator passes `methods=['GET']`"*

The code it later wrote does exactly that. The intent shaped the output rather
than being checked after the fact, which is the whole argument for sending
intents at plan time.

**The "only you can decide" box** caught something no test would ask:

> *"`charge()` returns `jsonify(ok=True)` → `{"ok": true}`, while the task
> specifies `{status: ok}`. I followed the task, but if the repo has an unwritten
> envelope convention, this route breaks it."*

**Approve → execute → check → ready.** Four findings, including one against its
own work:

> *"Change is entirely unverified — never executed once."*

Total: $0.95 of usage. Changes left uncommitted, as designed.

### On that number

It is **not a bill.** This machine authenticates by OAuth with no API key, so
`total_cost_usd` is what those tokens would have cost at API rates — a usage
proxy on a subscription. The UI said *"stop after 5 dollars"*, which was a lie
and is now *"stop after 5 units of usage · runs on your Claude subscription —
the cap is a ceiling on how much work a runaway task may do, not a bill."*

---

## 3. What the running UI caught that 32 data-layer tests did not

Worth its own section, because it happened again and the lesson is the same one
v0.8 recorded.

- a committed-clean file rendered as NEW
- an untracked file that moved again rendered as EDITED
- `<task-notification>` leaking into visible history
- a fresh session showing "no turns" while a 153-turn session existed
- a loop sitting at its gate rendering as idle after a reload
- the approve button below a five-paragraph risks box, off the bottom of the rail

Nine spurious "running" turns were also found only by running against real
transcripts — all of them `/compact` machinery.

**Verify against the running app, not just tests.** Third release in a row that
this rule has paid for itself.

---

## 4. Where the original plan was wrong

Recorded rather than tidied away.

- **"`4a` is blocked — Python won't give us a type surface at 39% annotation."**
  Wrong, and corrected under challenge. An AST gives the public surface
  regardless of annotations. Measured afterwards: **120/120 files parse, 75%
  have a public surface**, median 2 entries, p90 14, max 107. `4a` shipped.

- **"Self-reported intent coverage is a model grading itself."** Also wrong, and
  the correction was the user's: *"that is asking another agent to check whether
  the first agent is correct or not… either way it's a second agent acting as a
  discriminator to the first agent."* Discrimination is not self-grading, and
  the check phase is built as the former.

- **A constraint attributed to the user that they never stated.** They said Keel
  should be *closeable*. I recorded *small*, and built to it. Caught by them, not
  by me.

The pattern across all three: the plan was most wrong where it reasoned about
the work instead of measuring it.

---

## 5. Carried to v1

- **Layout and UI changes** — explicitly deferred by the user at release:
  *"we might have some layout changes and bug changes we do later."*
- **The stale preset label** — `preset` is one app-level value while layouts are
  per-tab, so the toolbar can read "Lite" over four panes. Cosmetic, known,
  untouched.
- **`2e` live view** — skipped by decision. It is what the stats rail becomes.
- **`2b` relationship navigator** — the handoff calls it an alternative to `4a`,
  and `4a` shipped.
- **Browser auto-reload on save** — watcher and `reload()` both exist; only the
  trigger is missing.
- **Test → debugger in one click.** Precondition still unmet: `aipenv`, the 3.10
  env matching `core`'s Flask config, still has no `debugpy`.
- **Code-splitting** — still a 4.6MB single chunk.
- Per-hunk staging, palette files+sessions, conditional breakpoints.

---

## Carried forward, still true

- Never test against real repos; disposable fixtures only.
- `~/.claude.json` is read-only, permanently.
- Your rules live with you, never forced onto a production repository.
- Prove tricky logic as a pure module before wiring a UI.
- Mechanisms and judgment stay labelled as different things.
- The loop ends at *ready to review*, never at *merged*.
- **Verify against the running app, not just tests.**
