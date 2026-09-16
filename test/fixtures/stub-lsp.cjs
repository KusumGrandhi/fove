/**
 * A language server that does nothing but keep score.
 *
 * Enough LSP to be started, told about a buffer and asked one question. What
 * makes it useful as a fixture is that it answers `textDocument/definition`
 * ONLY for documents it was actually sent a `didOpen` for -- which is exactly
 * how a real server behaves, and exactly the behaviour a client that races its
 * own notifications against its own requests falls foul of.
 *
 * It appends its pid to the file named by STUB_LSP_LOG on start, so a test can
 * count how many servers a client decided it needed.
 */
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  process.stdout.write("stub-lsp 1.0.0\n");
  process.exit(0);
}

fs.appendFileSync(process.env.STUB_LSP_LOG, process.pid + "\n");

const open = new Set();
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    // Ask the client what a real server asks, and record what it says. A
    // client that answers null here leaves a language server with no
    // interpreter and no third-party imports.
    send({
      jsonrpc: "2.0", id: 9001, method: "workspace/configuration",
      params: { items: [{ section: "python" }, { section: "python.analysis" }] },
    });
    return;
  }
  if (msg.id === 9001 && "result" in msg) {
    fs.appendFileSync(process.env.STUB_LSP_LOG, "config:" + JSON.stringify(msg.result) + "\n");
    return;
  }
  if (msg.method === "textDocument/didOpen") return open.add(msg.params.textDocument.uri);
  if (msg.method === "textDocument/didClose") return open.delete(msg.params.textDocument.uri);
  if (msg.method === "exit") return process.exit(0);
  if (msg.id === undefined) return; // any other notification

  if (msg.method === "textDocument/definition") {
    const uri = msg.params.textDocument.uri;
    // Unknown document: the honest answer is that there is nothing here.
    const result = open.has(uri)
      ? [{ uri, range: { start: { line: 7, character: 0 }, end: { line: 7, character: 4 } } }]
      : null;
    return send({ jsonrpc: "2.0", id: msg.id, result });
  }
  send({ jsonrpc: "2.0", id: msg.id, result: null });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString("ascii"))[1]);
    const start = split + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});
