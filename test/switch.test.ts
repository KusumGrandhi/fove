import { expect, test, describe, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { InspectorProxy, ANTHROPIC } from "../src/proxy/server.js";

/**
 * The claim M5 rests on: swapping provider is a routing change inside the
 * proxy, so the client keeps its connection and the UI keeps its state.
 */

/** Spin up a throwaway upstream server for the proxy to forward to. */
async function upstreamServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0 };
}

describe("seamless provider switch", () => {
  let a: Server | undefined;
  let b: Server | undefined;
  let proxy: InspectorProxy | undefined;
  afterEach(() => { a?.close(); b?.close(); proxy?.stop(); a = b = undefined; proxy = undefined; });

  test("the proxy URL is stable across a provider change", async () => {
    const A = await upstreamServer((_q, res) => res.end('{"provider":"anthropic"}'));
    const B = await upstreamServer((q, res) =>
      res.end(JSON.stringify({ provider: "kimi", auth: q.headers.authorization })));
    a = A.server; b = B.server;

    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${A.port}`, label: "Anthropic" });
    const url = await proxy.start();

    const r1 = await (await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })).json() as any;
    expect(r1.provider).toBe("anthropic");

    // Switch: same proxy, same URL, no restart.
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${B.port}`, authToken: "kimi-key", thirdParty: true, label: "Kimi" });
    expect(proxy.baseUrl).toBe(url);

    const r2 = await (await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })).json() as any;
    expect(r2.provider).toBe("kimi");
    expect(r2.auth).toBe("Bearer kimi-key");   // provider's own credential applied
    expect(proxy.current.thirdParty).toBe(true);
  });

  test("captures from both providers land in one history", async () => {
    const A = await upstreamServer((_q, res) => res.end('{"model":"claude-opus-5"}'));
    const B = await upstreamServer((_q, res) => res.end('{"model":"kimi-k2.5"}'));
    a = A.server; b = B.server;
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${A.port}`, label: "A" });
    const url = await proxy.start();
    await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${B.port}`, thirdParty: true, label: "B" });
    await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 80));
    const models = proxy.captures.list().map((c) => c.model);
    expect(models).toContain("kimi-k2.5");
    expect(models).toContain("claude-opus-5");
  });

  test("switching back to Anthropic drops the third-party credential", async () => {
    const A = await upstreamServer((q, res) =>
      res.end(JSON.stringify({ auth: q.headers.authorization })));
    a = A.server;
    proxy = new InspectorProxy();
    proxy.setUpstream({ baseUrl: `http://127.0.0.1:${A.port}`, authToken: "third-party", thirdParty: true, label: "X" });
    const url = await proxy.start();
    expect(((await (await fetch(`${url}/x`, { method: "POST", body: "{}" })).json()) as any).auth).toBe("Bearer third-party");

    proxy.setUpstream({ ...ANTHROPIC, baseUrl: `http://127.0.0.1:${A.port}` });
    const back = (await (await fetch(`${url}/x`, { method: "POST", body: "{}" })).json()) as any;
    expect(back.auth).not.toBe("Bearer third-party");
    expect(proxy.current.thirdParty).toBeFalsy();
  });
});
