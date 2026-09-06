/** Streaming conversation view. */

import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { C, fit } from "./theme.ts";

export interface Turn {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  agent?: string;
}

/** Wrap text to a width, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (line.length + word.length + (line ? 1 : 0) <= width) {
        line = line ? `${line} ${word}` : word;
      } else {
        if (line) out.push(line);
        // A single word longer than the width is hard-split.
        let w = word;
        while (w.length > width) { out.push(w.slice(0, width)); w = w.slice(width); }
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const ROLE = {
  user:      { glyph: "▸", fg: C.accent },
  assistant: { glyph: " ", fg: C.fg },
  tool:      { glyph: "⚙", fg: C.faint },
  system:    { glyph: "·", fg: C.dim },
} as const;

export function Conversation(props: { turns: Turn[]; width?: number; maxLines?: number }) {
  const dims = useTerminalDimensions();
  const width = () => props.width ?? dims().width;

  const lines = () => {
    const w = width() - 4;
    const out: { text: string; fg: string; glyph: string }[] = [];
    for (const t of props.turns) {
      const style = ROLE[t.role];
      const body = t.agent ? `[${t.agent}] ${t.text}` : t.text;
      const wrapped = wrap(body, w);
      wrapped.forEach((l, i) => {
        out.push({ text: l, fg: style.fg, glyph: i === 0 ? style.glyph : " " });
      });
      if (t.role !== "tool") out.push({ text: "", fg: C.dim, glyph: " " });
    }
    const max = props.maxLines ?? out.length;
    return out.slice(-max);
  };

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Show when={lines().length > 0} fallback={
        <text content="  (no messages yet — type a prompt and press ⏎)" style={{ fg: C.dim }} />
      }>
        <For each={lines()}>
          {(l) => (
            <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
              <text content={` ${l.glyph} `} style={{ fg: l.fg, flexShrink: 0 }} />
              <text content={fit(l.text, Math.max(0, width() - 3))} style={{ fg: l.fg, flexShrink: 0 }} />
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}
