/**
 * The Debug Adapter Protocol wire format, as pure functions.
 *
 * DAP frames look like HTTP: `Content-Length: <n>\r\n\r\n<json>`. That is the
 * same shape as LSP, and the same class of thing as the IDE protocol already
 * implemented in `ide.ts` -- but with one difference that matters here.
 *
 * Unlike everything else in fove, a debug session is **stateful against a live
 * process**: "read it again" is not a recovery strategy. A dropped or
 * misframed message does not resolve on the next poll, it desynchronises the
 * session. So the framing is a pure, separately-tested module rather than
 * something inlined into a socket handler.
 *
 * The two things a naive implementation gets wrong, both covered by tests:
 *   - **Content-Length counts bytes, not characters.** A non-ASCII value in a
 *     variable (a path, an exception message, any user data) makes the two
 *     differ, and slicing by character silently truncates every later frame.
 *   - **TCP does not preserve message boundaries.** A read can deliver half a
 *     header, several whole messages, or a header split mid-word, so the
 *     decoder has to be a resumable buffer rather than a per-chunk parser.
 */

/** A DAP message: request, response or event. */
export interface DapMessage {
  seq?: number;
  type: "request" | "response" | "event";
  command?: string;
  event?: string;
  arguments?: unknown;
  body?: unknown;
  request_seq?: number;
  success?: boolean;
  message?: string;
}

const SEP = "\r\n\r\n";

/**
 * Frame one message for the wire.
 *
 * The length is the byte count of the UTF-8 body, which is why this returns a
 * Buffer rather than a string: building the header from `body.length` would be
 * wrong the moment the payload contains anything outside ASCII.
 */
export function encode(msg: DapMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}${SEP}`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * A resumable decoder for a byte stream.
 *
 * Feed it whatever a socket hands over; it returns the messages that are now
 * complete and retains any partial frame for the next call.
 */
export class DapDecoder {
  // Typed as the general Buffer, since `concat` and `subarray` return one
  // backed by whichever ArrayBuffer kind the runtime chose.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Append bytes, and take every message that is now complete. */
  push(chunk: Buffer): DapMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: DapMessage[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(SEP, 0, "ascii");
      // The header has not finished arriving; wait for more.
      if (headerEnd < 0) break;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = contentLength(header);
      if (length === null) {
        // A header with no usable Content-Length cannot be recovered from by
        // guessing a size -- drop it and resync on the next frame rather than
        // consuming an arbitrary number of bytes.
        this.buffer = this.buffer.subarray(headerEnd + SEP.length);
        continue;
      }

      const start = headerEnd + SEP.length;
      // The body is still arriving. Note this compares *bytes*, which is the
      // whole reason the buffer is not a string.
      if (this.buffer.length < start + length) break;

      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        out.push(JSON.parse(body) as DapMessage);
      } catch {
        // One malformed body costs that message only: the frame length was
        // still valid, so the stream stays in sync.
      }
    }
    return out;
  }

  /** Bytes held pending a complete frame, for tests and diagnostics. */
  get pending(): number {
    return this.buffer.length;
  }
}

/**
 * Read Content-Length from a header block.
 *
 * Field names are case-insensitive, and adapters may send other fields
 * (Content-Type) alongside it.
 */
export function contentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== "content-length") continue;
    const n = Number(line.slice(at + 1).trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}
