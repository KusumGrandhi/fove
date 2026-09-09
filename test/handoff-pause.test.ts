/**
 * Pausing the loop at a phase boundary.
 *
 * The design mock says "pause after this step". Execution is a single `claude`
 * invocation for the whole plan, so there is no step boundary to stop on -- a
 * button promising one would be a lie about how the loop works.
 *
 * The boundary that does exist is between execution and the review, and it is
 * a genuine place to take over: the work is finished and on disk, and nothing
 * has judged it yet. That is what these tests pin down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffService } from "../src/main/handoffService.js";
import { IntentStore } from "../src/main/intentStore.js";

let bin: string;
let repo: string;
let originalPath: string | undefined;

/**
 * A `claude` that answers whatever it is asked.
 *
 * Agents return their answer by *writing a file* now, not through
 * `structured_output` -- that returns null under `--agent`, measured against
 * the installed CLI. So the fake finds the path in the prompt and writes to
 * it, which is exactly what the real agents are told to do.
 */
function fakeClaude(): void {
  const p = join(bin, "claude");
  writeFileSync(p, `#!/bin/sh
OUT=$(printf '%s\n' "$@" | grep -o '/[^ ]*\.json' | tail -1)
if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  case "$OUT" in
    *plan.json)   echo '{"summary":"do it","steps":[{"n":1,"action":"edit"}]}' > "$OUT" ;;
    *review.json) echo '{"findings":[]}' > "$OUT" ;;
    *drift.json)  echo '{"violations":[]}' > "$OUT" ;;
  esac
fi
echo '{"is_error":false,"result":"done","total_cost_usd":0.2,"session_id":"s1"}'
`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "fove-bin-"));
  repo = mkdtempSync(join(tmpdir(), "fove-repo-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  fakeClaude();
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const service = (): HandoffService =>
  new HandoffService({ load: async () => ({ intents: [] }) } as unknown as IntentStore);

describe("the pause request", () => {
  it("is off until asked for", () => {
    const s = service();
    expect(s.isPauseRequested(repo)).toBe(false);
  });

  it("can be set and taken back", () => {
    const s = service();
    s.requestPause(repo, true);
    expect(s.isPauseRequested(repo)).toBe(true);
    s.requestPause(repo, false);
    expect(s.isPauseRequested(repo)).toBe(false);
  });

  it("tells the renderer, so the button can show its state", () => {
    const s = service();
    const seen = vi.fn();
    s.on("changed", seen);
    s.requestPause(repo, true);
    expect(seen).toHaveBeenCalled();
  });
});

describe("stopping at the boundary", () => {
  it("ends after execution, before anything reviews the work", async () => {
    const s = service();
    await s.start(repo, "a task", 5);
    s.requestPause(repo, true);
    await s.approve(repo);

    const st = s.state(repo);
    expect(st.phase).toBe("stopped");
    // The wording has to say the work exists: stopping is not reverting.
    expect(st.stoppedReason).toContain("on disk");
    expect(st.checks).toEqual([]);
  });

  it("runs the review through to ready when not asked to pause", async () => {
    // The control: without the request the loop must reach its normal end.
    const s = service();
    await s.start(repo, "a task", 5);
    await s.approve(repo);

    expect(s.state(repo).phase).toBe("ready");
  });

  it("is consumed by the pause it caused, not left armed", async () => {
    /*
     * A latched request would pause the *next* handoff too, which nobody
     * asked for and which would look like the loop breaking.
     */
    const s = service();
    await s.start(repo, "a task", 5);
    s.requestPause(repo, true);
    await s.approve(repo);

    expect(s.isPauseRequested(repo)).toBe(false);
  });

  it("is cleared by a reset", async () => {
    const s = service();
    s.requestPause(repo, true);
    s.reset(repo);
    expect(s.isPauseRequested(repo)).toBe(false);
  });
});
