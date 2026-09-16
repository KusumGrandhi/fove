import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspService, SERVERS } from "../src/main/lsp.js";

/**
 * The editor opens a buffer and asks about it in the same breath.
 *
 * `didOpen` and the definition request are two separate IPC messages handled
 * concurrently in main, so for a while both found an empty server map and each
 * started its own language server. `didOpen` reached one and every request
 * reached the other, which had never heard of the file -- so Cmd-click in a
 * Python file answered null, silently, and kept answering null because the
 * renderer only re-sends `didOpen` for a buffer it has not already synced.
 *
 * These drive a stub server (see fixtures/stub-lsp.cjs) that answers only for
 * documents it was really told about, which is what makes the race visible.
 */
describe("one language server per root, however it is asked for", () => {
  let dir: string;
  let log: string;
  const uri = "file:///tmp/whatever.stub";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fove-lsp-"));
    log = join(dir, "spawns.log");
    writeFileSync(log, "");
    process.env.STUB_LSP_LOG = log;
    SERVERS.stub = [{ bin: process.execPath, args: [join(__dirname, "fixtures/stub-lsp.cjs")] }];
  });

  afterEach(() => {
    delete SERVERS.stub;
    delete process.env.STUB_LSP_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = (): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
  // Only the pid lines are spawns; the stub also records what it was told.
  const spawnCount = (): number => lines().filter((l) => /^\d+$/.test(l)).length;
  const configReplies = (): unknown[] =>
    lines().filter((l) => l.startsWith("config:")).map((l) => JSON.parse(l.slice("config:".length)));

  const open = (svc: LspService, root: string): Promise<void> =>
    svc.notify(root, "stub", "textDocument/didOpen", {
      textDocument: { uri, languageId: "stub", version: 1, text: "x = 1\n" },
    });

  const define = (svc: LspService, root: string): Promise<unknown> =>
    svc.request(root, "stub", "textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });

  test("a notification and a request racing each other share one server", async () => {
    const svc = new LspService();
    // Deliberately NOT awaited in sequence: this is main's two IPC handlers,
    // which is where the bug lived.
    const [, definition] = await Promise.all([open(svc, dir), define(svc, dir)]);
    svc.stopAll();

    expect(spawnCount()).toBe(1);
    expect(definition).not.toBeNull();
  });

  test("the server that gets the buffer is the one that gets the questions", async () => {
    const svc = new LspService();
    await Promise.all([open(svc, dir), define(svc, dir)]);
    // The second click re-syncs nothing -- the renderer knows the buffer is
    // already open -- so it only works if the same server is still answering.
    const again = await define(svc, dir);
    svc.stopAll();

    expect(again).not.toBeNull();
    expect(spawnCount()).toBe(1);
  });

  test("a different root gets its own server", async () => {
    const other = mkdtempSync(join(tmpdir(), "fove-lsp-"));
    const svc = new LspService();
    await Promise.all([open(svc, dir), open(svc, other)]);
    svc.stopAll();
    rmSync(other, { recursive: true, force: true });

    expect(spawnCount()).toBe(2);
  });

  test("a language with no server installed stays quiet rather than throwing", async () => {
    const svc = new LspService();
    expect(await svc.available("nothing-serves-this")).toBeNull();
    expect(await define(svc, dir).then(() => "asked", () => "threw")).toBe("asked");
    svc.stopAll();
  });

  test("workspace/configuration is answered, not shrugged at", async () => {
    /*
     * Answering null here is what made go-to-definition look like it "works on
     * variables but not on functions": with no interpreter, a language server
     * has no site-packages, so every third-party import resolves to nothing
     * while local names on the same line resolve fine.
     *
     * The interpreter itself is whatever this machine happens to have, so the
     * assertion is on the shape the protocol requires -- one entry per item
     * asked for -- rather than on a path that would differ per machine.
     */
    const svc = new LspService();
    await open(svc, dir);
    // The reply is a notification-shaped round trip the client does not await,
    // so give it a moment to land before killing the server that asked.
    for (let i = 0; i < 50 && configReplies().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    svc.stopAll();

    const [reply] = configReplies();
    expect(reply, "the server asked for configuration and got no reply").toBeDefined();
    expect(Array.isArray(reply)).toBe(true);
    expect((reply as unknown[]).length, "one entry per requested section").toBe(2);
    for (const entry of reply as unknown[]) expect(entry).toBeTypeOf("object");
  });

  test("a server installed mid-session is found once the probe is forgotten", async () => {
    // What the Setup Check sheet's Install button does: it puts a language
    // server on the machine after the editor has already concluded there is
    // none. Without the forget the app installs pyright for you and then goes
    // on behaving exactly as if you had none.
    const svc = new LspService();
    const installed = SERVERS.stub!;
    delete SERVERS.stub;

    expect(await svc.available("stub")).toBeNull();

    SERVERS.stub = installed;
    expect(await svc.available("stub"), "still cached, as designed").toBeNull();

    svc.forget("stub");
    expect(await svc.available("stub")).toBe(process.execPath);
    svc.stopAll();
  });
});
