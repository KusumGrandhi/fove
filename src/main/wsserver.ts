/**
 * A minimal WebSocket server (RFC 6455), enough for the Claude Code IDE
 * protocol and nothing more.
 *
 * Hand-rolled rather than pulling in `ws`: the server side of the handshake is
 * a SHA-1 of the client key, and the only frames this protocol exchanges are
 * text, ping/pong and close. Adding a native-adjacent dependency to an Electron
 * app that already needs `@electron/rebuild` is a cost worth avoiding.
 *
 * Deliberate limits, valid for this use: no extensions (permessage-deflate is
 * never negotiated), no fragmentation on send, and inbound continuation frames
 * are reassembled but binary payloads are ignored.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";

/** RFC 6455 handshake constant. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsConnection {
  send(text: string): void;
  close(): void;
  readonly headers: Record<string, string>;
}

export interface WsServerOptions {
  /** Rejects the upgrade when it returns false -- used for the auth token. */
  authorize?: (headers: Record<string, string>) => boolean;
  onConnection?: (conn: WsConnection) => void;
  onMessage?: (conn: WsConnection, text: string) => void;
  onClose?: (conn: WsConnection) => void;
  /** Subprotocols this server accepts; the first match is echoed back. */
  protocols?: string[];
}

function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Encode one text frame. Server frames are never masked. */
function encode(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function createWsServer(opts: WsServerOptions): {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  broadcast(text: string): void;
  close(): Promise<void>;
} {
  const clients = new Set<WsConnection>();

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let headers: Record<string, string> = {};
    let conn: WsConnection | null = null;
    // Reassembly across continuation frames.
    let fragOp = 0;
    let frag: Buffer[] = [];

    const destroy = () => {
      if (conn) { clients.delete(conn); opts.onClose?.(conn); conn = null; }
      socket.destroy();
    };

    socket.on("error", destroy);
    socket.on("close", () => { if (conn) { clients.delete(conn); opts.onClose?.(conn); conn = null; } });

    socket.on("data", (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);

      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buf.length > 16 * 1024) destroy(); // no unbounded header buffering
          return;
        }
        const raw = buf.subarray(0, end).toString("utf8");
        buf = buf.subarray(end + 4);
        const lines = raw.split("\r\n");
        headers = {};
        for (const line of lines.slice(1)) {
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const key = headers["sec-websocket-key"];
        if (!key || !/websocket/i.test(headers["upgrade"] ?? "")) {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        if (opts.authorize && !opts.authorize(headers)) {
          // The token did not match: refuse the upgrade outright.
          socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return;
        }
        // A client that asked for a subprotocol MUST be told which one was
        // chosen; RFC 6455 requires it to fail the connection otherwise. Claude
        // Code requests "mcp", and dropped the socket right after a successful
        // upgrade until this was echoed back.
        const offered = (headers["sec-websocket-protocol"] ?? "")
          .split(",").map((x) => x.trim()).filter(Boolean);
        const chosen = offered.find((p) => opts.protocols?.includes(p) ?? true);
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          (chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : "") +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
        upgraded = true;
        conn = {
          headers,
          send: (text: string) => { if (!socket.destroyed) socket.write(encode(text)); },
          close: () => { if (!socket.destroyed) { socket.write(encode("", 0x8)); socket.end(); } },
        };
        clients.add(conn);
        opts.onConnection?.(conn);
      }

      // Decode client frames (always masked, per RFC).
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0]! & 0x80) !== 0;
        const opcode = buf[0]! & 0x0f;
        const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const start = off + maskLen;
        const payload = Buffer.from(buf.subarray(start, start + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        buf = buf.subarray(start + len);

        if (opcode === 0x8) { conn?.close(); destroy(); return; }
        if (opcode === 0x9) { if (!socket.destroyed) socket.write(encode(payload.toString(), 0xa)); continue; }
        if (opcode === 0xa) continue; // pong

        if (opcode === 0x0) frag.push(payload);
        else { fragOp = opcode; frag = [payload]; }

        if (fin) {
          const full = Buffer.concat(frag);
          frag = [];
          if (fragOp === 0x1 && conn) opts.onMessage?.(conn, full.toString("utf8"));
        }
      }
    });
  });

  return {
    server,
    listen: (port: number, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        // Loopback only: this port accepts commands that open files.
        server.listen(port, host, () => {
          const a = server.address();
          resolve(typeof a === "object" && a ? a.port : port);
        });
      }),
    broadcast: (text: string) => { for (const c of clients) c.send(text); },
    close: () => new Promise<void>((resolve) => {
      for (const c of clients) c.close();
      server.close(() => resolve());
    }),
  };
}

export const newAuthToken = (): string => randomUUID();
