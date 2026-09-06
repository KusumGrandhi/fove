/**
 * Raw API inspector: the wire traffic underneath the conversation.
 *
 * Shows exactly what Claude Code sends on your behalf -- request size (your
 * system prompt, skills and memories, in bytes), latency, status, and the cache
 * economics that explain why one turn is fast and the next is slow.
 */

import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { Capture } from "../proxy/capture.ts";
import { formatDuration, formatTokens } from "../data/usage.ts";
import { wrap } from "./Conversation.tsx";
import { C, fit } from "./theme.ts";

const kb = (n: number | undefined): string =>
  n === undefined ? "-" : n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}B`;

export function captureRow(c: Capture, width: number): string {
  const status = c.error ? "ERR" : String(c.status ?? "…");
  const dur = c.endedAt && c.startedAt ? formatDuration(c.endedAt - c.startedAt) : "…";
  const path = (() => { try { return new URL(c.url).pathname; } catch { return c.url; } })();
  const tok = c.usage
    ? `${formatTokens((c.usage.input ?? 0) + (c.usage.cacheRead ?? 0) + (c.usage.cacheWrite ?? 0))}`
    : "-";
  const right = `${status.padStart(4)}${dur.padStart(8)}${kb(c.requestBody?.length).padStart(7)}${tok.padStart(9)}`;
  return fit(` ${path}  ${c.model ?? ""}`, Math.max(0, width - right.length)) + right;
}

export function Inspector(props: {
  captures: Capture[];
  cursor: number;
  detail: boolean;
  upstream: string;
  thirdParty?: boolean;
}) {
  const dims = useTerminalDimensions();
  const w = () => dims().width;
  const rows = () => Math.max(3, dims().height - 8);
  const selected = () => props.captures[props.cursor];

  const detailLines = () => {
    const c = selected();
    if (!c) return [];
    const out: { text: string; fg: string }[] = [];
    const add = (text: string, fg: string = C.dim) => out.push({ text, fg });
    add(`${c.method} ${c.url}`, C.accent);
    add("");
    add("request headers", C.fg);
    for (const [k, v] of Object.entries(c.requestHeaders)) add(`  ${k}: ${v}`, C.faint);
    if (c.requestBody) {
      add("");
      add(`request body (${kb(c.requestBody.length)})`, C.fg);
      for (const l of wrap(c.requestBody.slice(0, 4000), w() - 4)) add(`  ${l}`, C.faint);
    }
    if (c.responseBody) {
      add("");
      add(`response ${c.status} (${kb(c.responseBody.length)})`, C.fg);
      for (const l of wrap(c.responseBody.slice(0, 4000), w() - 4)) add(`  ${l}`, C.faint);
    }
    if (c.error) { add(""); add(`error: ${c.error}`, C.error); }
    return out.slice(0, rows());
  };

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
        <text
          content={fit(`  upstream: ${props.upstream}${props.thirdParty ? "  ⚠ third-party" : ""}`, w())}
          style={{ fg: props.thirdParty ? C.running : C.accent, flexShrink: 0 }}
        />
      </box>
      <Show
        when={props.captures.length > 0}
        fallback={<text content="  no requests captured yet" style={{ fg: C.dim, flexShrink: 0 }} />}
      >
        <Show when={!props.detail}>
          <text
            content={fit("  path                                              model    status   time   req    tokens", w())}
            style={{ fg: C.faint, flexShrink: 0 }}
          />
          <For each={props.captures.slice(0, rows())}>
            {(c, i) => {
              const sel = () => i() === props.cursor;
              return (
                <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel() ? C.selBg : undefined }}>
                  <text
                    content={fit(captureRow(c, w()), w())}
                    style={{ fg: sel() ? C.fg : c.error ? C.error : C.dim, flexShrink: 0 }}
                  />
                </box>
              );
            }}
          </For>
        </Show>
        <Show when={props.detail}>
          <For each={detailLines()}>
            {(l) => (
              <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
                <text content={fit(l.text, w())} style={{ fg: l.fg, flexShrink: 0 }} />
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  );
}
