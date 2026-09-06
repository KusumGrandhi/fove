/**
 * Background sessions: the third kind of agent.
 *
 * These run against a fixture under a temporary CLAUDE_CONFIG_DIR, never the
 * user's real ~/.claude.
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const CWD = "/tmp/fove-fixture-project";

const line = (o: unknown) => JSON.stringify(o) + "\n";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-sessions-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { slugForCwd } = await import("../src/data/transcript.js");
  const projects = join(dir, "projects", slugForCwd(CWD));
  await mkdir(projects, { recursive: true });

  // A session actively working: last record is a user turn, touched just now.
  await writeFile(join(projects, "aaaa.jsonl"),
    line({ type: "ai-title", aiTitle: "Rename reviews" }) +
    line({ type: "assistant", message: {} }) +
    line({ type: "user", message: {} }));

  // A session waiting on input: last record is an assistant turn.
  await writeFile(join(projects, "bbbb.jsonl"),
    line({ type: "agent-name", agentName: "Needs me" }) +
    line({ type: "user", message: {} }) +
    line({ type: "assistant", message: {} }));

  // A finished session, deliberately aged out of the active window.
  const done = join(projects, "cccc.jsonl");
  await writeFile(done,
    line({ type: "ai-title", aiTitle: "Finished" }) +
    line({ type: "system", subtype: "away_summary" }));
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(done, old, old);

  // Empty transcripts are skipped rather than surfaced as ghosts.
  await writeFile(join(projects, "dddd.jsonl"), "");
});

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("backgroundSessions", () => {
  test("finds every peer session in the project folder", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["aaaa", "bbbb", "cccc"]);
  });

  test("reads the CLI's own name for a session, from either record type", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    expect(rows.find((r) => r.sessionId === "aaaa")?.name).toBe("Rename reviews");
    expect(rows.find((r) => r.sessionId === "bbbb")?.name).toBe("Needs me");
  });

  test("distinguishes working, needs-input and done", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    expect(rows.find((r) => r.sessionId === "aaaa")?.state).toBe("working");
    expect(rows.find((r) => r.sessionId === "bbbb")?.state).toBe("needs-input");
    expect(rows.find((r) => r.sessionId === "cccc")?.state).toBe("done");
  });

  test("an empty transcript is not reported as a session", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    expect(rows.some((r) => r.sessionId === "dddd")).toBe(false);
  });

  test("marks the transcript the caller is already showing", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const { slugForCwd } = await import("../src/data/transcript.js");
    const current = join(dir, "projects", slugForCwd(CWD), "aaaa.jsonl");
    const rows = await backgroundSessions(CWD, current);
    expect(rows.find((r) => r.sessionId === "aaaa")?.isCurrent).toBe(true);
    expect(rows.find((r) => r.sessionId === "bbbb")?.isCurrent).toBe(false);
  });

  test("newest first", async () => {
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    const times = rows.map((r) => r.mtimeMs);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("a malformed line is skipped, not thrown", async () => {
    const { slugForCwd } = await import("../src/data/transcript.js");
    const p = join(dir, "projects", slugForCwd(CWD), "eeee.jsonl");
    await writeFile(p, "{not json\n" + line({ type: "ai-title", aiTitle: "Survived" }));
    const { backgroundSessions } = await import("../src/main/sessions.js");
    const rows = await backgroundSessions(CWD);
    expect(rows.find((r) => r.sessionId === "eeee")?.name).toBe("Survived");
    await rm(p, { force: true });
  });
});
