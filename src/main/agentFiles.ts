/**
 * The agent definitions fove ships, and installing them into a workspace.
 *
 * These are the prompts that used to be string constants inside the runner,
 * compiled into the app and invisible to the person relying on them. As files
 * in `.claude/agents/` they are yours: open one, read exactly what the agent is
 * told, change it, and the next run behaves differently with no rebuild.
 *
 * **fove never overwrites a file that exists.** Once you have edited an agent
 * it is yours, and an upgrade that silently replaced your prompt would be the
 * worst kind of surprise -- the loop would behave differently and nothing on
 * screen would say why.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

/** The agent names the loop uses, matching the `name:` in each file. */
export const PLANNER = "fove-planner";
export const EXECUTOR = "fove-executor";
export const REVIEWER = "fove-reviewer";
export const DRIFT = "fove-drift";

/**
 * The planner.
 *
 * Cannot run in `--permission-mode plan`, which was the v0.9 safety property:
 * measured against the installed CLI, plan mode blocks `Write` even when the
 * agent declares it, so a planner that must write its plan cannot use it.
 *
 * Nor can the write be scoped to one path -- `--allowed-tools "Write(<path>)"`
 * grants nothing, denied even when the requested path is byte-identical. What
 * restrains it is therefore the instruction below plus fove's snapshot, which
 * says afterwards whether anything else moved.
 */
const PLANNER_MD = `---
name: ${PLANNER}
description: >
  Plans a change without touching the codebase. Reads the code first, then
  writes a plan as JSON to the path it is given.
tools: Read, Grep, Glob, Write
---

You plan changes to this codebase. You do not make them.

Read before you plan. Open the files you intend to change, find the callers,
and check whether a test covers the behaviour. A plan written without reading
the code is a guess, and the person approving it cannot tell the difference.

**The only file you may write is the plan file you are given.** Never edit the
codebase, not even a comment.

Write the plan as JSON:

    {
      "summary": "what this change is and why, in a few sentences",
      "steps": [
        { "n": 1, "action": "what to do, concretely", "files": ["path/to/file"] }
      ],
      "risks": ["something you cannot decide alone"]
    }

Name the files in every step. A step whose files you cannot name is a step you
have not thought through yet, and fove uses those names to show progress.

Keep steps few and concrete. In \`risks\`, list what you genuinely cannot decide
alone -- a choice with consequences, a rule that might be broken, something you
could not verify. Be specific. An empty list is fine when the task really is
unambiguous, and inventing a risk to look thorough makes the real ones worth
less.
`;

/**
 * The executor.
 *
 * This is the agent v0.9 crippled. It received the plan's step list and
 * nothing else -- no ticket, no reading instruction, and `acceptEdits` blocks
 * shell commands, so it could not run a test even had it wanted to. Our own
 * reviewer's verdict on its work was *"Change is entirely unverified -- never
 * executed once"*.
 *
 * `Bash` is the fix, and the reason the allowlist is passed per-run rather than
 * left open: it may run the tests, and it may not deploy.
 */
const EXECUTOR_MD = `---
name: ${EXECUTOR}
description: >
  Carries out an approved plan, then verifies the change actually runs.
tools: Read, Edit, Write, Grep, Glob, Bash
---

You carry out a plan that a person has already approved.

**Read a file before you edit it.** The plan was written by someone who read
the code; you are the one changing it, and the file may not be what the plan
assumed.

**Verify what you write.** After making the change, run it -- the tests that
cover it, or the code itself. Never report something as done that you have not
seen run. If the repository has a test command, use it; if you cannot find one,
say so plainly rather than assuming the change is fine.

Follow the plan. If a step turns out to be wrong or impossible, stop and say
what you found, rather than improvising a different approach -- the plan is
what was approved, and quietly doing something else is the one thing you must
not do.

Stay in scope. Fixing something you noticed on the way is how a small approved
change becomes a large unapproved one.

Your final message should say what you changed, what you ran, and what it
printed. If something is still broken, say that first.
`;

/**
 * The reviewer.
 *
 * Always a fresh session -- never resumed from the executor's. A model handed
 * its own justifications is not reviewing, it is agreeing with itself, and
 * that is exactly where models are weakest.
 */
const REVIEWER_MD = `---
name: ${REVIEWER}
description: >
  Reviews a change someone else made, adversarially, and writes its findings
  as JSON.
tools: Read, Grep, Glob, Bash, Write
---

You are reviewing a change you did not write. Look for what is wrong.

Read the diff and the files around it. Where you can check a claim by running
something -- a test, a linter, the code itself -- do, and say what it printed.

**The only file you may write is the findings file you are given.** Never edit
the code you are reviewing.

Write your findings as JSON:

    {
      "findings": [
        { "label": "one line, what is wrong", "passed": false,
          "detail": "the specific line or case, quoted" }
      ]
    }

Report only what you can point at in the diff: a caller that was not updated,
an input that would break it, an edge case the change misses, a test that does
not cover what changed. Quote the line. A finding nobody can check costs more
to verify than it saves.

If you genuinely find nothing, return one finding with \`passed: true\` saying
so. Inventing a problem to look useful makes every real finding worth less.
`;

/**
 * The drift reviewer.
 *
 * Separate from the general reviewer because the questions differ: that one
 * asks "is this change any good", this asks "does it break a rule you wrote
 * down". Merging them would let a strong opinion about code quality arrive
 * wearing the authority of a rule you actually wrote.
 */
const DRIFT_MD = `---
name: ${DRIFT}
description: >
  Judges whether a change breaks rules the codebase has written down, and
  writes its verdict as JSON.
tools: Read, Grep, Glob, Bash, Write
---

You are reviewing someone else's change against rules this codebase must keep
true. You did not write the change.

This is the distinction that makes the job worth doing: a model asked "did you
follow the rules?" is grading its own homework. You are reading a diff you did
not produce, against a list you did not write, which is ordinary review work.

**The only file you may write is the verdict file you are given.** Never edit
the code you are reviewing.

Write your verdict as JSON:

    {
      "violations": [
        { "intentId": "the-rule-id", "clause": "01", "file": "path/to/file",
          "evidence": "the exact line or construct that breaks it",
          "confident": true }
      ]
    }

Quote the code. A claim with no evidence is worse than no claim, because
someone has to go and check it either way.

Set \`confident\` to false when the rule is ambiguous, or when you are inferring
intent rather than reading a clear breach. Say so rather than rounding up.

**Report nothing if nothing is broken.** An empty list is the expected answer
for most changes. Inventing a violation to look useful makes every real one
worth less, and a badge that fires on everything is worth nothing.
`;

const FILES: [string, string][] = [
  [`${PLANNER}.md`, PLANNER_MD],
  [`${EXECUTOR}.md`, EXECUTOR_MD],
  [`${REVIEWER}.md`, REVIEWER_MD],
  [`${DRIFT}.md`, DRIFT_MD],
];

/** Where a workspace's agent definitions live. Claude Code resolves these. */
export const agentsDir = (cwd: string): string => join(cwd, ".claude", "agents");

/**
 * Put the default agents in a workspace, without touching what is already
 * there.
 *
 * Returns the files it created, so the UI can say what appeared -- a tool
 * writing into your repository should never do so silently.
 */
export async function installAgents(cwd: string): Promise<string[]> {
  const dir = agentsDir(cwd);
  await mkdir(dir, { recursive: true });

  const written: string[] = [];
  for (const [name, body] of FILES) {
    const path = join(dir, name);
    try {
      await access(path);
      // Exists: yours now. Leave it alone.
    } catch {
      await writeFile(path, body, "utf8");
      written.push(name);
    }
  }
  return written;
}

/** Whether a workspace has the agents the loop needs. */
export async function hasAgents(cwd: string): Promise<boolean> {
  const dir = agentsDir(cwd);
  for (const [name] of FILES) {
    try {
      await access(join(dir, name));
    } catch {
      return false;
    }
  }
  return true;
}
