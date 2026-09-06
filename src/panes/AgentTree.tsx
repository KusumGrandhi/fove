/** Indented tree of agents: the navigation view. */

import { For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { AgentNode } from "../data/types.ts";
import { formatDuration, formatTokens, totalTokens } from "../data/usage.ts";
import { C, fit, statusColor, statusGlyph } from "./theme.ts";

export { fit };

/** Right-hand columns: model, duration, tokens, tool count. */
const META = 13 + 8 + 9 + 7;

export function treeRow(n: AgentNode, width: number): { name: string; meta: string } {
  const indent = "  ".repeat(Math.max(0, n.depth));
  const nameW = Math.max(8, width - META - indent.length - 3);
  const dur = n.startedAt && n.endedAt ? formatDuration(n.endedAt - n.startedAt) : "—";
  const label = n.label ? `${n.name} · ${n.label}` : n.name;
  return {
    name: ` ${indent}`,
    meta:
      fit(` ${label} `, nameW) +
      fit((n.model ?? "").replace("claude-", ""), 13) +
      dur.padStart(8) +
      formatTokens(totalTokens(n.usage)).padStart(9) +
      `${n.toolCalls.length}t`.padStart(7),
  };
}

export function AgentTreeView(props: {
  agents: AgentNode[];
  selectedId?: string;
  /** Override for tests/probes; defaults to the live terminal width. */
  width?: number;
}) {
  const dims = useTerminalDimensions();
  const width = () => props.width ?? dims().width;
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <For each={props.agents}>
        {(n) => {
          const w = width();
          const r = treeRow(n, w);
          const sel = props.selectedId === n.id;
          return (
            <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel ? C.selBg : undefined }}>
              <text content={r.name} />
              <text content={statusGlyph(n.status)} style={{ fg: statusColor(n.status), flexShrink: 0 }} />
              <text
                content={fit(r.meta, Math.max(0, w - r.name.length - 1))}
                style={{ fg: sel ? C.fg : C.dim, flexShrink: 0 }}
              />
            </box>
          );
        }}
      </For>
    </box>
  );
}
