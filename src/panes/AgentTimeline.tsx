/**
 * Horizontal swimlanes: one row per agent, wall-clock x-axis.
 *
 * This is the "why is it slow" instrument. It answers, at a glance, whether
 * agents that look parallel actually overlapped -- something the CLI's spinner
 * tree cannot show at all.
 */

import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { AgentNode } from "../data/types.ts";
import { formatDuration, formatTokens, totalTokens } from "../data/usage.ts";
import { C, fit, statusColor } from "./theme.ts";

const BAR = "█";
const TRACK = "·";

export interface TimelineProps {
  agents: AgentNode[];
  windowStart: number;
  windowEnd: number;
  /** Override for tests/probes; defaults to the live terminal width. */
  width?: number;
  selectedId?: string;
}

/** Render one lane as a fixed-width string of track and bar characters. */
export function laneFor(
  node: AgentNode,
  windowStart: number,
  windowEnd: number,
  cells: number,
): string {
  const span = Math.max(1, windowEnd - windowStart);
  const start = node.startedAt ?? windowStart;
  const end = node.endedAt ?? windowEnd;
  let a = Math.floor(((start - windowStart) / span) * cells);
  let b = Math.ceil(((end - windowStart) / span) * cells);
  a = Math.max(0, Math.min(cells - 1, a));
  b = Math.max(a + 1, Math.min(cells, b));
  return TRACK.repeat(a) + BAR.repeat(b - a) + TRACK.repeat(cells - b);
}

export function AgentTimeline(props: TimelineProps) {
  const labelW = 24;
  const metaW = 17; // " 12m34s  827.1k"
  const dims = useTerminalDimensions();
  const width = () => props.width ?? dims().width;
  const cells = () => Math.max(10, width() - labelW - metaW);

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Show
        when={props.agents.length > 0}
        fallback={<text content="  no subagents in this session" style={{ fg: C.dim, flexShrink: 0 }} />}
      >
        <For each={props.agents}>
          {(n) => {
            const dur =
              n.startedAt && n.endedAt ? formatDuration(n.endedAt - n.startedAt) : "—";
            const label = n.label || n.name;
            const sel = props.selectedId === n.id;
            return (
              <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel ? C.selBg : undefined }}>
                <text content={fit(` ${label}`, labelW)} style={{ fg: sel ? C.fg : C.dim, flexShrink: 0 }} />
                <text
                  content={laneFor(n, props.windowStart, props.windowEnd, cells())}
                  style={{ fg: statusColor(n.status), flexShrink: 0 }}
                />
                <text
                  content={fit(
                    `${dur.padStart(8)}${formatTokens(totalTokens(n.usage)).padStart(9)}`,
                    metaW,
                  )}
                  style={{ fg: C.dim, flexShrink: 0 }}
                />
              </box>
            );
          }}
        </For>
      </Show>
    </box>
  );
}
