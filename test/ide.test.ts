/**
 * The IDE server, driven exactly as Claude Code drives it: a real WebSocket
 * handshake carrying the lock file's token, then JSON-RPC over the socket.
 *
 * Runs against a temporary CLAUDE_CONFIG_DIR so it never writes a lock file
 * into the user's real ~/.claude/ide (which would advertise a dead IDE).
 */
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let ide: import("../src/main/ide.js").IdeService;
let port: number;
let token: string;

const opened: string[] = [];
let diffVerdict: "saved" | "rejected" = "saved";

/** A WebSocket client just complete enough to speak this protocol. */
async function client(tok: string, headerName = "x-claude-code-ide-authorization", protocol?: string) {
  const key = crypto.randomBytes(16).toString("base64");
  const sock = net.connect({ host: "127.0.0.1", port });
  await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });
  sock.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
    `${headerName}: ${tok}\r\n\r\n`);

  let buf = Buffer.alloc(0);
  let status = "";
  let rawHeaders = "";
  let handshaken = false;
  const queue: string[] = [];
  const waiters: ((s: string) => void)[] = [];

  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (!handshaken) {
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      rawHeaders = buf.subarray(0, i).toString();
      status = rawHeaders.split("\r\n")[0]!;
      handshaken = true;
      buf = buf.subarray(i + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const l0 = buf[1]! & 0x7f;
      let off = 2, len = l0;
      if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const s = buf.subarray(off, off + len).toString();
      buf = buf.subarray(off + len);
      const w = waiters.shift();
      if (w) w(s); else queue.push(s);
    }
  });

  await new Promise((r) => setTimeout(r, 150));
  const send = (o: unknown) => {
    const data = Buffer.from(JSON.stringify(o));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]!));
    let h: Buffer;
    if (data.length < 126) h = Buffer.from([0x81, 0x80 | data.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(data.length, 2); }
    sock.write(Buffer.concat([h, mask, masked]));
  };
  const next = (ms = 3000): Promise<string> => {
    const q = queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), ms);
      waiters.push((s) => { clearTimeout(t); res(s); });
    });
  };
  const call = async (method: string, params?: unknown, id = 1) => {
    send({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      const raw = await next();
      const m = JSON.parse(raw) as { id?: number };
      if (m.id === id) return m as Record<string, unknown>;
      // Skip notifications that arrive first.
    }
  };
  return { sock, send, next, call, status: () => status,
           headers: () => rawHeaders, close: () => sock.destroy() };
}

/** Swapped per test, so the browser tool can be driven without a real pane. */
let browserPanes: {
  paneId: string; url: string;
  console: { level: string; text: string; source?: string; line?: number }[];
  network: { url: string; method: string; status?: number; error?: string }[];
}[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fove-ide-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { IdeService } = await import("../src/main/ide.js");
  ide = new IdeService({
    openFile: (r) => { opened.push(r.filePath); },
    openDiff: async (req) => {
      if (diffVerdict === "saved") {
        const { FileService } = await import("../src/main/files.js");
        const r = await new FileService().write(req.newPath, req.newContents);
        if (r.error) return "rejected";
      }
      return diffVerdict;
    },
    closeTab: () => {},
    closeAllDiffTabs: () => {},
    openEditors: async () => [{ filePath: "/w/a.ts", isDirty: false }],
    currentSelection: async () => ({
      filePath: "/w/a.ts", text: "hi",
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 }, isEmpty: false },
    }),
    isDirty: async () => true,
    save: async () => true,
    workspaceFolders: () => ["/w"],
    browserProblems: () => browserPanes,
  });
  port = (await ide.start())!;
  const files = await readdir(join(dir, "ide"));
  token = JSON.parse(await readFile(join(dir, "ide", files[0]!), "utf8")).authToken;
});

afterAll(async () => {
  await ide.stop();
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("IDE lock file", () => {
  test("advertises fove on the port it is listening on", async () => {
    const files = await readdir(join(dir, "ide"));
    expect(files).toEqual([`${port}.lock`]);
    const lock = JSON.parse(await readFile(join(dir, "ide", files[0]!), "utf8"));
    expect(lock.ideName).toBe("fove");
    expect(lock.transport).toBe("ws");
    expect(lock.workspaceFolders).toEqual(["/w"]);
    expect(typeof lock.authToken).toBe("string");
    expect(lock.pid).toBe(process.pid);
  });

  test("stop() removes the advertisement so no dead IDE is offered", async () => {
    const { IdeService } = await import("../src/main/ide.js");
    const tmp = new IdeService({
      openFile: () => {}, openDiff: async () => "saved", closeTab: () => {},
      closeAllDiffTabs: () => {}, openEditors: async () => [],
      currentSelection: async () => null, isDirty: async () => false,
      save: async () => true, workspaceFolders: () => ["/x"],
    });
    const p = (await tmp.start())!;
    expect((await readdir(join(dir, "ide"))).includes(`${p}.lock`)).toBe(true);
    await tmp.stop();
    expect((await readdir(join(dir, "ide"))).includes(`${p}.lock`)).toBe(false);
  });

  test("a stale fove lock from a crashed run is swept, other editors' are not", async () => {
    const { writeFile } = await import("node:fs/promises");
    const ideDir = join(dir, "ide");
    // A fove lock whose process is long gone, and a foreign one that must survive.
    await writeFile(join(ideDir, "59991.lock"), JSON.stringify({
      pid: 999999, ideName: "fove", transport: "ws", workspaceFolders: ["/x"], authToken: "t" }));
    await writeFile(join(ideDir, "59992.lock"), JSON.stringify({
      pid: 999999, ideName: "Visual Studio Code", transport: "ws", workspaceFolders: ["/x"], authToken: "t" }));

    const { IdeService } = await import("../src/main/ide.js");
    const svc = new IdeService({
      openFile: () => {}, openDiff: async () => "saved", closeTab: () => {},
      closeAllDiffTabs: () => {}, openEditors: async () => [],
      currentSelection: async () => null, isDirty: async () => false,
      save: async () => true, workspaceFolders: () => ["/x"],
    });
    await svc.start();
    const after = await readdir(ideDir);
    expect(after).not.toContain("59991.lock");   // ours, dead pid -> swept
    expect(after).toContain("59992.lock");       // someone else's -> untouched
    await svc.stop();
    await rm(join(ideDir, "59992.lock"), { force: true });
  });

  test("env() gives a claude PTY what it needs to prefer this IDE", () => {
    expect(ide.env()).toEqual({ CLAUDE_CODE_SSE_PORT: String(port), ENABLE_IDE_INTEGRATION: "true" });
  });
});

describe("handshake", () => {
  test("a wrong token is refused, not upgraded", async () => {
    const c = await client("not-the-token");
    expect(c.status()).toContain("401");
    c.close();
  });

  test("the mcp subprotocol is echoed back -- Claude Code drops the socket otherwise", async () => {
    const c = await client(token, "x-claude-code-ide-authorization", "mcp");
    expect(c.status()).toContain("101");
    expect(c.headers().toLowerCase()).toContain("sec-websocket-protocol: mcp");
    c.close();
  });

  test("permessage-deflate is never negotiated, since frames are sent uncompressed", async () => {
    const c = await client(token, "x-claude-code-ide-authorization", "mcp");
    expect(c.headers().toLowerCase()).not.toContain("permessage-deflate");
    c.close();
  });

  test("the real token upgrades", async () => {
    const c = await client(token);
    expect(c.status()).toContain("101");
    c.close();
  });
});

describe("JSON-RPC", () => {
  test("initialize reports tool capability", async () => {
    const c = await client(token);
    const r = await c.call("initialize", { protocolVersion: "2025-03-26" }) as { result: Record<string, unknown> };
    expect((r.result.capabilities as Record<string, unknown>).tools).toBeTruthy();
    expect((r.result.serverInfo as Record<string, string>).name).toBe("fove IDE");
    c.close();
  });

  test("tools/list exposes what Claude Code looks for", async () => {
    const c = await client(token);
    const r = await c.call("tools/list", {}, 2) as { result: { tools: { name: string }[] } };
    const names = r.result.tools.map((t) => t.name);
    for (const n of ["openFile", "openDiff", "getCurrentSelection", "getOpenEditors", "getWorkspaceFolders"]) {
      expect(names).toContain(n);
    }
    c.close();
  });

  test("getBrowserProblems says so plainly when no pane is open", async () => {
    const c = await client(token);
    browserPanes = [];
    const r = await c.call("tools/call", { name: "getBrowserProblems", arguments: {} }, 40) as
      { result: { content: { text: string }[] } };
    // An empty list would read as "the page is fine" when it means "no page".
    expect(r.result.content[0]!.text).toContain("No browser pane");
    c.close();
  });

  test("getBrowserProblems returns console errors and failed requests", async () => {
    const c = await client(token);
    browserPanes = [{
      paneId: "p1",
      url: "http://localhost:5000/",
      console: [{ level: "error", text: "TypeError: x is not a function", source: "app.js", line: 12 }],
      network: [{ url: "http://localhost:5000/api/z", method: "GET", status: 500 }],
    }];
    const r = await c.call("tools/call", { name: "getBrowserProblems", arguments: {} }, 41) as
      { result: { content: { text: string }[] } };
    const parsed = JSON.parse(r.result.content[0]!.text) as { panes: typeof browserPanes };
    expect(parsed.panes[0]!.url).toBe("http://localhost:5000/");
    expect(parsed.panes[0]!.console[0]!.text).toContain("TypeError");
    expect(parsed.panes[0]!.network[0]!.status).toBe(500);
    browserPanes = [];
    c.close();
  });

  test("openFile reaches the app and is acknowledged", async () => {
    const c = await client(token);
    opened.length = 0;
    const r = await c.call("tools/call", { name: "openFile", arguments: { filePath: "/w/x.ts" } }, 3) as
      { result: { content: { text: string }[] } };
    expect(opened).toEqual(["/w/x.ts"]);
    expect(r.result.content[0]!.text).toContain("/w/x.ts");
    c.close();
  });

  test("openDiff returns the CLI's expected verdict strings", async () => {
    // A writable path: accepting now persists, so an unwritable one would
    // correctly come back rejected.
    const target = join(dir, "verdict.ts");
    const c = await client(token);
    diffVerdict = "saved";
    let r = await c.call("tools/call", { name: "openDiff", arguments: {
      old_file_path: target, new_file_path: target, new_file_contents: "x", tab_name: "a.ts" } }, 4) as
      { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe("FILE_SAVED");

    diffVerdict = "rejected";
    r = await c.call("tools/call", { name: "openDiff", arguments: {
      old_file_path: target, new_file_path: target, new_file_contents: "x", tab_name: "a.ts" } }, 5) as
      { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe("DIFF_REJECTED");
    c.close();
  });

  test("a write that cannot land reports DIFF_REJECTED rather than claiming success", async () => {
    const c = await client(token);
    diffVerdict = "saved";
    const r = await c.call("tools/call", { name: "openDiff", arguments: {
      old_file_path: "/nonexistent-dir-xyz/a.ts", new_file_path: "/nonexistent-dir-xyz/a.ts",
      new_file_contents: "x", tab_name: "a.ts" } }, 22) as
      { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe("DIFF_REJECTED");
    c.close();
  });

  test("accepting a diff actually writes the file -- FILE_SAVED must not be a lie", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const target = join(dir, "diffed.txt");
    await writeFile(target, "old contents\n");

    const c = await client(token);
    diffVerdict = "saved";
    const r = await c.call("tools/call", { name: "openDiff", arguments: {
      old_file_path: target, new_file_path: target,
      new_file_contents: "new contents\n", tab_name: "diffed.txt" } }, 20) as
      { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe("FILE_SAVED");
    expect(await readFile(target, "utf8")).toBe("new contents\n");
    c.close();
  });

  test("rejecting a diff leaves the file untouched", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const target = join(dir, "kept.txt");
    await writeFile(target, "original\n");

    const c = await client(token);
    diffVerdict = "rejected";
    const r = await c.call("tools/call", { name: "openDiff", arguments: {
      old_file_path: target, new_file_path: target,
      new_file_contents: "should not land\n", tab_name: "kept.txt" } }, 21) as
      { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe("DIFF_REJECTED");
    expect(await readFile(target, "utf8")).toBe("original\n");
    c.close();
  });

  test("an unknown method is an error, not a crash", async () => {
    const c = await client(token);
    const r = await c.call("no/such/method", {}, 6) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
    c.close();
  });

  test("getCurrentSelection reports what the editor last sent", async () => {
    const c = await client(token);
    const r = await c.call("tools/call", { name: "getCurrentSelection", arguments: {} }, 30) as
      { result: { content: { text: string }[] } };
    const sel = JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
    expect(sel.filePath).toBe("/w/a.ts");
    // 0-based, matching VS Code's own selection_changed payloads.
    expect((sel.selection as Record<string, unknown>).start).toEqual({ line: 1, character: 0 });
    c.close();
  });

  test("getLatestSelection survives after the notification, so Claude can ask later", async () => {
    const c = await client(token);
    ide.notifySelection({
      filePath: "/w/later.ts", text: "z",
      selection: { start: { line: 7, character: 2 }, end: { line: 7, character: 3 }, isEmpty: false },
    });
    await sleepMs(100);
    const r = await c.call("tools/call", { name: "getLatestSelection", arguments: {} }, 31) as
      { result: { content: { text: string }[] } };
    expect(JSON.parse(r.result.content[0]!.text).filePath).toBe("/w/later.ts");
    c.close();
  });

  test("selection_changed is pushed to a connected client", async () => {
    const c = await client(token);
    await c.call("initialize", {}, 7);
    ide.notifySelection({
      filePath: "/w/sel.ts", text: "chunk",
      selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 6 }, isEmpty: false },
    });
    const raw = await c.next();
    const m = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
    expect(m.method).toBe("selection_changed");
    expect(m.params.filePath).toBe("/w/sel.ts");
    c.close();
  });
});

describe("spawn environment", () => {
  test("inherited Claude Code vars are scrubbed, so a spawned claude is not a 'child session'", async () => {
    // Simulate fove being launched from a terminal already running Claude Code.
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const { PtyService } = await import("../src/main/pty.js");
      const svc = new PtyService(() => {}, () => {});
      const s = svc.spawn({
        paneId: "envtest",
        cmd: "/bin/sh",
        // The sentinel is echoed after env, so the reader knows the whole
        // environment has arrived rather than guessing from a variable name --
        // env's output spans several writes and is not ordered.
        args: ["-c", "env; echo __FOVE_ENV_END__; sleep 0.2"],
        cols: 80, rows: 24,
        env: { CLAUDE_CODE_SSE_PORT: "1234", ENABLE_IDE_INTEGRATION: "true" },
      });
      const seen = await new Promise<string>((resolve) => {
        let acc = "";
        /*
         * Resolve as soon as the marker arrives; the timeout is a backstop.
         *
         * Commands run through a login+interactive shell, which sources the
         * user's whole profile before exec'ing -- slower to first output than
         * a bare spawn, and slower still under full-suite load. A fixed wait
         * failed roughly 1 run in 14 there while passing alone, which makes
         * every future failure ambiguous.
         *
         * The sentinel the command echoes after `env` is the only reliable
         * "output complete" signal: env's variables span several writes and
         * arrive in no particular order, so waiting on any one of them can
         * resolve on a partial read.
         */
        const timer = setTimeout(() => resolve(acc), 15000);
        s.proc.onData((d: string) => {
          acc += d;
          if (acc.includes("__FOVE_ENV_END__")) {
            clearTimeout(timer);
            resolve(acc);
          }
        });
      });
      svc.kill("envtest");

      // The poisoning vars must be gone...
      expect(seen).not.toMatch(/CLAUDE_CODE_CHILD_SESSION=/);
      expect(seen).not.toMatch(/CLAUDE_CODE_ENTRYPOINT=/);
      // ...while the IDE vars this app sets survive.
      expect(seen).toMatch(/CLAUDE_CODE_SSE_PORT=1234/);
      expect(seen).toMatch(/ENABLE_IDE_INTEGRATION=true/);
      // A user's explicit config dir is not collateral damage.
      expect(seen).toMatch(/CLAUDE_CONFIG_DIR=/);
    } finally {
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
      delete process.env.CLAUDECODE;
    }
  });
});

describe("pane commands resolve through the login shell", () => {
  test("a command only on the interactive PATH is found", async () => {
    const { PtyService } = await import("../src/main/pty.js");
    const svc = new PtyService(() => {}, () => {});
    // `claude` lives in /opt/homebrew/bin or ~/.local/bin -- paths added by
    // ~/.zshrc, not present in the PATH this process inherited. A bare spawn
    // would exit 1; going through the login shell finds it.
    const s = svc.spawn({
      paneId: "shellresolve",
      cmd: "sh",
      args: ["-c", "command -v claude >/dev/null && echo FOUND || echo MISSING"],
      cols: 80, rows: 24,
    });
    const out = await new Promise<string>((resolve) => {
      let acc = "";
      s.proc.onData((d: string) => { acc += d; });
      setTimeout(() => resolve(acc), 2500);
    });
    svc.kill("shellresolve");
    expect(out).toContain("FOUND");
  });

  test("arguments survive quoting, including spaces", async () => {
    const { PtyService } = await import("../src/main/pty.js");
    const svc = new PtyService(() => {}, () => {});
    const s = svc.spawn({
      paneId: "quoting",
      cmd: "echo",
      args: ["one two", "three"],
      cols: 80, rows: 24,
    });
    /*
     * Resolve as soon as the expected output arrives, with the timeout only as
     * a backstop.
     *
     * A fixed 2s wait passed alone and failed occasionally under full-suite
     * load, where a login shell has not echoed yet -- a flaky test rather than
     * a real defect, but one that makes every future failure ambiguous.
     */
    const out = await new Promise<string>((resolve) => {
      let acc = "";
      const timer = setTimeout(() => resolve(acc), 8000);
      s.proc.onData((d: string) => {
        acc += d;
        if (acc.includes("one two three")) { clearTimeout(timer); resolve(acc); }
      });
    });
    svc.kill("quoting");
    expect(out).toContain("one two three");
  });
});
