# fove v0.10 — the agent is Claude Code's, the UI is ours

## Why this is a rewrite and not a patch

The v0.9 handoff loop works and produces bad results. The reason is in the
code, not the model:

```ts
// handoffRunner.ts, the executor's entire context
"Carry out this plan exactly. Do not expand its scope.",
`Goal: ${plan.summary}`,
...plan.steps.map((s) => `${s.n}. ${s.action}`),
```

That is all it gets. Not the ticket, not the planner's reading of the codebase,
no instruction to open a file before editing it, and `acceptEdits` blocks shell
commands so it **cannot run a test even if it wanted to**. Then a reviewer with
the actual diff finds six real problems, and it looks like the model is bad.

Three hardcoded prompt strings, compiled into the app. Changing how the
executor behaves means editing TypeScript and rebuilding.

Claude Code already solves this. An agent is a markdown file: frontmatter for
name, description and tools, then the prompt. `--agent <name>` runs it. So:

**The agent is Claude Code's problem. The UI is ours.**

---

## What was measured before designing

Every claim below was run against the installed CLI, not read from `--help`.

| Finding | Consequence |
|---|---|
| `--agent` loads `.claude/agents/*.md` and the prompt takes effect | The whole approach works |
| `tools:` frontmatter is authoritative — an agent got exactly the four it declared | Capability is declared per agent, in the file |
| **`--json-schema` returns `structured_output: null` when `--agent` is used** | The v0.9 mechanism for getting a plan back **cannot be kept** |
| **`--permission-mode plan` blocks `Write` even when the agent declares it** | A planner that writes its plan cannot run in plan mode |
| `--allowed-tools "Write(/path/to/one/file)"` scopes writes to a single path | This replaces plan mode as the safety property |
| A planner so scoped wrote its plan and left the codebase untouched — 0 denials, $0.16 | Proven, not assumed |

The last two are the design. **Plan-mode-cannot-write is replaced by
write-only-to-this-one-file**, which is a narrower and more checkable claim: the
plan file is the only path it may touch, and the tree afterwards proves whether
that held.

---

## Shape

```
.claude/agents/           ← yours, editable, on this laptop
  fove-planner.md
  fove-executor.md
  fove-reviewer.md

~/.fove/runs/<run-id>/    ← what each phase produced
  plan.json
  review.json
```

fove spawns `claude --agent fove-planner …`, waits, reads the file. It does not
compose prompts. It does not know what a good plan looks like. It knows where
the file is and what to draw.

### The three agents

**`fove-planner`** — `Read, Grep, Glob, Write`, permission `acceptEdits`,
`--allowed-tools "Read,Grep,Glob,Write(<run>/plan.json)"`. Reads the codebase,
writes one JSON file. Cannot touch anything else, and the change set after it
runs is the proof.

**`fove-executor`** — `Read, Edit, Write, Grep, Glob, Bash`. This is the one
v0.9 crippled. It gets the ticket *and* the plan, is told to read a file before
editing it, and **is expected to run the tests**. Bash is the point: a change
nobody ran is what produced *"Change is entirely unverified — never executed
once"* in our own review.

**`fove-reviewer`** — `Read, Grep, Glob, Bash, Write`, fresh session. Already
right in v0.9 and stays: the reviewer never resumes the writer's session,
because a model handed its own justifications is not reviewing.

### What fove keeps

The safety machine, unchanged, because it is the part that is good:

- `shared/handoff.ts` — phases, the approval gate, `ready` is terminal
- the gate itself: **a plan is approved before it runs**, and a revised plan is
  unapproved again
- `shared/progress.ts` — steps tick from the tree, never from self-report
- `shared/changeset.ts` — this turn's work vs. what was already dirty
- drift, per-file accept, commit-not-merge, the worklist, the cards

### What fove loses

`handoffRunner.ts`'s three prompt constants and the `--json-schema` plumbing
(~200 lines). Replaced by: spawn, wait, read a file.

---

## Milestones

Each ends somewhere usable, and each is verified from `/Applications` — see
Verification for why that is stated explicitly.

### M1 — the runner speaks agent (~half a day)

`agentRunner.ts` replaces `handoffRunner.ts`. One function: run an agent, with
a scoped tool list and an output path, return the parsed file.

`~/.fove/runs/<id>/` per handoff, so a run's artifacts are inspectable after the
fact and two workspaces cannot collide.

Ships the planner only. Execution still on the old path, so the gate keeps
working while half the loop is new.

**Done when:** a plan comes back from an agent file, the working tree is
untouched, and editing `.claude/agents/fove-planner.md` visibly changes the next
plan with no rebuild.

### M2 — an executor that verifies its own work (~1 day)

The fix for the six findings. `fove-executor.md` gets `Bash` and is told to run
what it wrote.

**The safety question this opens, stated rather than buried:** `Bash` with
`acceptEdits` means the agent can run commands. Mitigated by `--allowed-tools`
with a command allowlist (`Bash(npm test:*)`, `Bash(pytest:*)`, `Bash(git
diff:*)`) rather than bare `Bash`, so it can verify and cannot deploy. The
allowlist lives in the agent file, which means **you can see and change it**.

**Done when:** on the scratch Flask repo the executor runs the tests it wrote,
and a deliberately broken change is caught by the executor rather than reaching
the reviewer.

### M3 — first-run setup (~half a day)

The agent files have to exist. fove writes the three defaults into
`.claude/agents/` on first use in a workspace, and **never overwrites** — once
you have edited one it is yours. Keel shows which agent each phase used, with a
link to open the file.

**Done when:** a fresh clone runs the loop with no manual setup, and an edited
agent survives a fove upgrade.

### M4 — the UI (~1–2 days)

The half you asked for twice. Against the `4a` mock, with what is real:

- the plan at the gate rendered from the file, **editable before approving** —
  it is a file, so this is now cheap
- per-phase agent shown by name, click to open the definition
- the executor's Bash output streamed into the rail, so *"running tests"* is
  visible while it happens rather than inferred from a clock
- keep: step ticks, elapsed, drift, per-file accept, decisions count

### M5 — delete the old path (~half a day)

`handoffRunner.ts` and its tests go. Not before M4, so there is always a working
loop.

---

## What could go wrong, and what happens then

**`--agent` output goes back to prose.** The agent may talk instead of writing
the file. Mitigation: the file's absence is a hard failure with a plain message,
never a silent empty plan — the same rule as drift, where *"nothing found"* and
*"could not check"* must never render the same.

**The executor's Bash allowlist is wrong for a repo.** It is a file you edit.
That is the argument for the whole design.

**Two workspaces, one `.claude/agents/`.** Agents are per-repo by Claude Code's
own resolution. Accepted: that is the behaviour you asked for.

**An agent file someone else wrote.** `.claude/agents/` in a shared repo is not
ours. fove writes only when absent, and shows which file each phase used.

---

## Verification

Per milestone above. Two rules over all of it, both earned:

**Run it from `/Applications`, never `npx electron .`.** A dev-launched app
inherits the terminal's PATH; a Finder-launched one gets
`/usr/bin:/bin:/usr/sbin:/sbin` and cannot find `claude`. That shipped, and
every "verified" I reported was on the wrong launch path.

**Measure the CLI, do not read about it.** Two of this plan's load-bearing
findings — `--json-schema` breaking under `--agent`, and plan mode blocking the
plan file — contradict what the flags suggest, and both would have shipped as
bugs.

### The gate

v0.10 ships when the same ticket that produced six reviewer findings produces a
change that **runs**. Not zero findings — a reviewer that finds nothing is
usually a reviewer that did not look. The bar is that *"never executed once"*
can no longer be one of them.
