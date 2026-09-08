# fove v0.9 — Keel, a console for delegated work

v0.7 made fove a daily driver. v0.8 (in progress) fixes the human loop: better
layouts, readable history, review of what changed.

v0.9 is about the other mode. You either drive the panes yourself, or you
**hand a task to an agent and watch it through Keel** — an overlay over the
panes, dismissed with Escape, that answers one question: *what did it do, and
is any of it wrong?* When Keel confuses you, you close it and the panes are
still there, still running.

Intents belong to a repository, not to fove: each workspace carries its own
rules, committed alongside its code. `core` is used throughout this document as
the worked example because it is the repository with the most existing
convention to draw on — findings marked **[verified]** were measured against it,
and several changed the plan. Nothing here is specific to it.

---

## 0. The decision that shapes everything

Keel is **an overlay, not a mode and not a replacement IDE.**

The Keel design handoff proposes an application where source code is a
destination rather than a panel — no editor in the resting layout. As a
whole-app commitment that is a bet on a codebase we do not have (see §5). As a
**dismissible overlay** it is not a bet at all: the panes are underneath, and
if the summary cannot tell you enough, you close it and read the code. The
design becomes falsifiable per-use rather than all at once.

Consequences, which are constraints on everything below:

- Panes keep running while Keel is open. Nothing unmounts, no PTY dies, the
  agent does not pause.
- Keel layers **below** the command palette and below Claude's blocking diff
  **[verified: palette and DiffView are z-index 60; Keel takes 50]**, so an
  approval Claude is waiting on always wins.
- **Anything blocking must be visible with Keel closed.** An overlay cannot be
  the only home for a decision that stops work. The stats rail — already built,
  already collapsible — is where the current step and any blocking decision live.

---

## 1. Intents — the part worth getting right

An intent is **a rule about the codebase, in English, that must stay true**.
Not what code does (that is documentation, and it rots) but what it must never
stop doing. It is the thing you say in review — *"you can't do that here,
because…"* — written down where an agent can read it.

### They already exist

**[verified]** `core/AGENTS.md` is 148 lines and already contains them:

- never commit or push unless a human asks
- never skip pre-commit hooks
- no `print()` in production code
- never bare `except:`
- reuse code — search before writing new utilities
- whenever you create/update/delete a synced entity in Postgres, call the
  matching Elasticsearch sync helper in the same code path

So v0.9 is **not** "author intents from nothing". It is "make the rules already
written enforceable". That is a much smaller and much more honest job.

### Prose first, mechanisms as an upgrade

Every intent is prose. A **mechanism** — a grep, a test, a static rule — is
optional and is an *upgrade*, never an entry requirement.

This inverts an earlier position of mine that was wrong. Requiring a mechanism
before a rule may exist means you write four rules and stop, and the rules that
matter most are often the least checkable: *"error messages should say what to
do next"* will never have a mechanism and is exactly the nuance that makes a
codebase yours.

### Why keep any mechanisms at all

Not for simple rules versus complex ones. For **searches versus judgments**.

**[verified]** `core` has **zero** bare `except:` — that rule holds on prose
alone. It also has **19 files with `print()`** in `flask/core`, which
`AGENTS.md` forbids. Same document, same authority, one rule quietly violated
nineteen times.

The difference is that finding `print()` is a needle-in-haystack search across
2,571 files, and that is the one job where a deterministic check beats a model
outright — not because it is smarter, but because it does not get tired on file
seven of a nine-file diff.

So:

| Check is a… | Owner | Example |
|---|---|---|
| **search** — exhaustive, boring, high-volume | mechanism | `print()`, `float(` on money, missing ES sync |
| **judgment** — does this count as X | agent | "is this cache a sanctions cache", "is this error actionable" |

### The discriminator, and what it is actually for

A second agent reads the change and the intents and says **which intents are in
play**. This is real work that a mechanism cannot do, and it is the part I
initially got wrong.

A mechanism only runs once you already know it is relevant. If an agent edits
`providers/comply_advantage.py` to add a response cache, nothing in that diff
mentions sanctions; a file-glob lookup misses it, and a sanctions test only
fires if someone already wired it to that path. An agent reading the diff can
say *"this is a cache on the sanctions provider — the freshness clause
applies."* That is judgment, and it is the highest-value thing an agent does here.

**The honest limit** is not whether to use a discriminator, but what its verdict
means. Two failure shapes, badly asymmetric:

- *"clause applies and looks violated"* → you look. Cheap when wrong.
- *"no intents affected"* → Keel shows nothing, you merge. **Expensive when
  wrong, and invisible.**

Correlated failure bites the second case: a discriminator reading the same diff
with the same model as the writer shares its blind spots, and the misses cluster
exactly where the code is subtle. So:

**A discriminator's silence is a weaker signal than a mechanism's pass, and Keel
must render them differently.**

### The three signal strengths — the core UI commitment

| Signal | Rendered as | Meaning |
|---|---|---|
| Mechanism ran and passed | **proven** | Deterministic |
| Discriminator flagged a clause | **flagged — check this** | Worth your eyes |
| Nothing checked this change | **unchecked** | Never green |

The third row is the whole design. If "no agent objected" renders like "a test
passed", trust becomes unmeasurable. Kept distinct, every drop-back to the panes
where Keel said *unchecked* is a data point, and each one is a candidate for a
new mechanism — the deterministic floor grows from real friction instead of
guesswork.

### Schema — behaviour-scoped with a file hint

The handoff scopes intents to files (`bands.intent` beside `bands.ts`). That
does not survive `core`: *"a synced entity's Postgres write is always paired
with an ES sync"* spans **24 files** **[verified]**. File-scoped intents cannot
express it.

So intents are behaviour-scoped, with an optional glob narrowing where the
discriminator looks first:

```
id: es-sync-pairing
rule: A create/update/delete of a synced entity in Postgres calls the
      matching Elasticsearch sync helper in the same code path.
scope: flask/core/**            # a hint, not a boundary
mechanism: tools/checks/es_sync.py     # optional
```

Prose and `id` required. Everything else optional.

### Where intents live — outside the repository, always

`~/.fove/intents/<repo-identity>/*.md`. **Never inside the working tree.**

This is a hard constraint, not a preference. `core` is a production repository
shared with a team; adding a `.fove/` directory to it would mean opening a PR
that puts one developer's tooling config into everyone's checkout. That is not
ours to do, and a tool that requires it will simply not be used.

Consequences worth stating, because they are real costs:

- **Intents and mechanisms are yours, not the team's.** They do not arrive by
  `git pull` and nobody else benefits from them. That is the price of not
  touching the repo, and it is the right trade.
- **Keyed by repository identity, not path**, so a worktree of `core` shares
  the parent's intents rather than starting empty. Identity is the first remote
  URL, falling back to the root commit sha for a repo with no remote — both
  stable across clones and worktrees, unlike a filesystem path.
- **Mechanisms are scripts under `~/.fove/`**, run against the workspace
  directory. They never live in the repo either, so a mechanism cannot be a
  pre-commit hook or a CI check — it runs when fove asks it to, and only for
  you.
- **Nothing fove writes ever appears in `git status`.** A tool that dirties the
  working tree of a production repo is a tool you have to remember to clean up
  before every commit.

**`AGENTS.md` is the seed, read-only.** The first intents come from reading what
the repo already documents — `AGENTS.md`, `CLAUDE.md/`, a CONTRIBUTING file —
and copying them out into your own store. fove reads those files; it never
writes to them.

If a team later wants to share a set, that is an export — a file they choose to
commit, on their initiative. Not the default, and not something fove does on
its own.

---

## 2. The turn boundary — the foundation

Nothing in §3 works without knowing what a turn changed. Shared with v0.8 §1/§4,
and the argument for doing them together.

- Snapshot `git status` when a turn starts; diff against it when the turn ends.
- Per-worktree, so a session in one worktree cannot contaminate another.
- **Attribution is a heuristic, not a fact.** You edit files too, and so do
  background agents. The UI says *"changed during this turn"*, never *"the agent
  did this"*.

---

## 3. Keel itself

Opens on ⌘J. Escape closes. Opens on the **last completed turn**, not on a file:
the panes already do files well, and do this not at all.

Structure follows `2c` from the handoff — contract-first review — with the parts
that require infrastructure we do not have removed rather than faked.

**Header.** Task, files touched, elapsed, cost.

**Two summary boxes.**
- *Checked* — intents in play with a mechanism that ran.
- *Needs your judgment* — flagged clauses, and anything the agent itself said it
  could not verify. **Capped at three.** More than three means the task was
  scoped too widely, and the cap is the signal.

**Per file:** path, +/−, what changed. For Python, the before/after **`def`
signature set** — not a type surface (see §5), and labelled as such. Per-file
**accept** and **revert** — `applyPatch(cwd, patch, reverse)` already exists
**[verified: gitWrite.ts:166]**.

**Coverage line, always present:** *"4 of 9 files touch a known intent. 5
unchecked."* This is the honest one. It does not say safe; it says nothing was
looking.

**Constraint log.** Every accept/reject appends a line the agent reads on its
next task. Cheap, and it is the compounding mechanism — it is how the system
learns your taste without anything being retrained. Stored per repository
identity under `~/.fove/`, alongside the intents and for the same reason: it is
your judgment about someone else's codebase, and it stays on your machine.

---

## 4. Order

1. **Turn boundary** (§2). Deterministic; nothing works without it.
2. **Five intents from `AGENTS.md`**, prose only, plus two mechanisms
   (`print()` and ES-sync pairing — both **[verified]** as real and checkable).
   Prove the format survives contact before writing fifty.
3. **Keel overlay** (§3) showing the change set, grouped by intent where one
   applies, explicitly *unchecked* where none does.
4. **Constraint log.**
5. **Discriminator** — only after 1–4 are honest. It is more useful with a
   deterministic floor underneath it, and its best output is not a verdict but
   *"this clause applies and has no mechanism"*, which is what tells you where
   to write the next one.

**The checkpoint that matters:** after step 3, hand a real task to an agent in
`core` and use Keel on it. Then count. Every time you close Keel and go to the
panes because it confused you, that is the number the whole design is competing
with — and it should be logged, not remembered.

---

## 5. From the handoff: what is not being built, and why

The Keel design assumes a codebase this one is not. Measured, not guessed:

| Design dependency | Reality in `core` |
|---|---|
| `.intent` sibling per file | **0 exist** across 2,571 Python files **[verified]** |
| Contract extracted at build | Python, **39% of 22,767 defs have return annotations** **[verified]**. No build step emits a type surface. |
| Invariants `proven` per build | Needs a clause→mechanism index that does not exist |
| Telemetry keyed by file path | Sentry is per-exception; nothing keys metrics to paths **[verified]** |
| Shadow run against mirrored traffic | Infrastructure that does not exist and is not fove's to build |

Two consequences worth stating plainly rather than discovering later:

**Rule 6 of the handoff — shadow execution as a precondition for filing a
claim — cannot be honoured.** Honoured literally, no claim is ever filed and the
review screen is dead. Dropped, `2c` loses its strongest guarantee. We drop it
and say so: Keel reviews *changes*, not *proofs*.

**Rule 2 — "a card is generated, never authored" — is the rule that breaks.**
It is what makes a card immune to going stale, and it needs a type surface
Python does not give us. Every card in `core` would sit in the handoff's
*no intent / inferred* state, which the design treats as an edge case and which
would be the norm.

**Rule 3 — no editor in the resting layout — is deliberately not adopted.** The
overlay decision in §0 makes it unnecessary: the editor stays, Keel is what you
open. The handoff states rule 3 as a bet and says telemetry should settle it.
We have no telemetry, and the editor is what is being used today.

**Not built: the `4a` file card and the `2b` relationship navigator.** Both are
downstream of a contract model we do not have. Revisit if the type surface ever
becomes real.

**`3a` is a pitch artifact**, not a product surface — the handoff says so
itself. If it is wanted, it belongs in a README.

---

## 6. Honest risks

- **The 95% target is the right aim and the wrong assumption.** At 20 changes a
  day, 95% is one bad merge daily. The coverage line in §3 exists so the
  uncovered changes get your eyes rather than your trust, and the number gets
  measured rather than asserted.
- **The discriminator will miss things, and its misses cluster where the code is
  subtle** — which is where you needed it. This is why *unchecked* never renders
  green.
- **Intents can rot like any documentation.** A prose intent that no mechanism
  checks and no agent flags is a comment. The flag-count-to-mechanism pipeline
  in §1 is the only thing keeping the set alive.
- **Keel could become another thing to maintain.** The mitigation is that it
  reads what already exists — git, the transcript, `AGENTS.md` — and authors
  nothing that has to be kept in sync by hand.

---

## Carried forward, still true

- Never test against real repos; disposable fixtures only.
- `~/.claude.json` is read-only, permanently.
- Prove tricky logic as a pure module before wiring a UI.
- **Verify against the running app, not just tests.** v0.7's sharpest bug passed
  every unit test and appeared only against real debugpy.
- Check *which directory* a "not found" came from before calling it a bug.
