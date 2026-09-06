/**
 * AgentGrid -- the flagship view.
 *
 * A tile per running subagent, each streaming that agent's own reasoning in its
 * own scrollback. This is the thing a terminal structurally cannot do: plain
 * scrollback is one-dimensional, and tmux panes cannot see inside a single
 * Claude process. Claude Code's own UI collapses subagents to a spinner tree
 * and discards their reasoning entirely.
 *
 * Made possible by forwardSubagentText:true, which emits each subagent's text
 * and thinking blocks rather than only its tool calls.
 */

import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { AgentNode } from "../data/types.ts";
import { formatDuration, formatTokens, totalTokens } from "../data/usage.ts";
import { wrap } from "./Conversation.tsx";
import { C, fit, statusColor, statusGlyph } from "./theme.ts";

/** Choose a tile grid that stays legible: wide-ish tiles, few rows. */
export function tileLayout(
  count: number,
  width: number,
  height: number,
): { cols: number; rows: number; tileW: number; tileH: number } {
  if (count <= 0) return { cols: 1, rows: 1, tileW: width, tileH: height };
  // Prefer 1 col for 1, 2 for 2-4, 3 beyond -- but never narrower than 28 cols.
  let cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
  while (cols > 1 && Math.floor(width / cols) < 28) cols--;
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    cols,
    rows,
    tileW: Math.floor(width / cols),
    tileH: Math.max(3, Math.floor(height / rows)),
  };
}

/** The lines a tile shows: most recent transcript entries, wrapped. */
export function tileLines(node: AgentNode, w: number, h: number): { text: string; kind: string }[] {
  const body = h - 2; // header + separator
  if (body <= 0) return [];
  const out: { text: string; kind: string }[] = [];
  // Walk backwards so we keep the newest content when it overflows.
  for (let i = node.transcript.length - 1; i >= 0 && out.length < body * 2; i--) {
    const e = node.transcript[i]!;
    const prefix = e.kind === "thinking" ? "◇ " : e.kind === "tool_use" ? "⚙ " : "";
    for (const line of wrap(prefix + e.text.replace(/\s+/g, " "), w - 2).reverse()) {
      out.push({ text: line, kind: e.kind });
    }
  }
  return out.reverse().slice(-body);
}

/** tileLines padded out to exactly h-2 rows so the tile never shrinks. */
export function paddedLines(node: AgentNode, w: number, h: number): { text: string; kind: string }[] {
  const body = Math.max(0, h - 2);
  const lines = tileLines(node, w, h);
  while (lines.length < body) lines.push({ text: "", kind: "text" });
  return lines;
}

function Tile(props: { node: AgentNode; w: number; h: number; selected: boolean }) {
  const n = () => props.node;
  const title = () => {
    const label = n().label ?? n().name;
    const dur = n().startedAt ? formatDuration((n().endedAt ?? Date.now()) - n().startedAt!) : "";
    const tok = formatTokens(totalTokens(n().usage));
    const right = ` ${dur} ${tok}`;
    return fit(`${statusGlyph(n().status)} ${label}`, Math.max(0, props.w - right.length - 1)) + right;
  };
  return (
    <box style={{ flexDirection: "column", width: props.w, flexShrink: 0 }}>
      <text
        content={fit(title(), props.w)}
        style={{ fg: props.selected ? C.fg : statusColor(n().status), flexShrink: 0 }}
      />
      <text content={fit("─".repeat(props.w), props.w)} style={{ fg: C.faint, flexShrink: 0 }} />
      {/* Pad to a fixed height: OpenTUI does not clear rows a shorter
          render leaves behind, so a shrinking tile would keep stale text. */}
      <For each={paddedLines(n(), props.w, props.h)}>
        {(l) => (
          <text
            content={fit(` ${l.text}`, props.w)}
            style={{
              fg: n().status === "done" ? C.faint : l.kind === "thinking" ? C.thinking : C.fg,
              flexShrink: 0,
            }}
          />
        )}
      </For>
    </box>
  );
}

export function AgentGrid(props: {
  agents: AgentNode[];
  selectedId?: string;
  width?: number;
  height?: number;
}) {
  const dims = useTerminalDimensions();
  const width = () => props.width ?? dims().width;
  const height = () => props.height ?? dims().height - 6;

  // Running agents first -- they are what you are watching.
  const shown = () => {
    const running = props.agents.filter((a) => a.status === "running");
    const rest = props.agents.filter((a) => a.status !== "running");
    return [...running, ...rest].slice(0, 9);
  };
  const layout = () => tileLayout(shown().length, width(), height());
  const rowsOf = () => {
    const { cols } = layout();
    const out: AgentNode[][] = [];
    const list = shown();
    for (let i = 0; i < list.length; i += cols) out.push(list.slice(i, i + cols));
    return out;
  };

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Show
        when={shown().length > 0}
        fallback={
          <text
            content="  no subagents yet — they appear here as Claude spawns them"
            style={{ fg: C.dim, flexShrink: 0 }}
          />
        }
      >
        <For each={rowsOf()}>
          {(row) => (
            <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
              <For each={row}>
                {(n) => (
                  <Tile
                    node={n}
                    w={layout().tileW}
                    h={layout().tileH}
                    selected={props.selectedId === n.id}
                  />
                )}
              </For>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}
