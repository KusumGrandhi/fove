/**
 * terminal-helper -- M1: read-only session inspector.
 *
 * Enumerates the Claude Code sessions already on disk, replays one into an
 * AgentTree, and renders the subagent tree and execution timeline. No SDK, no
 * live query: this validates the DAG and cost logic against real transcripts
 * before anything drives a live session.
 */

import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createResource, createSignal, Show, For } from "solid-js";
import { listSessions } from "./data/transcript.ts";
import { replaySession } from "./data/replay.ts";
import { formatDuration, formatTokens } from "./data/usage.ts";
import { AgentTimeline } from "./panes/AgentTimeline.tsx";
import { AgentTreeView } from "./panes/AgentTree.tsx";
import { C, fit } from "./panes/theme.ts";
import type { SessionSummary } from "./data/types.ts";

type View = "sessions" | "tree" | "timeline";

/**
 * OpenTUI queries the terminal directly and ignores COLUMNS/LINES, reporting a
 * default 80x24 when there is no tty. Honouring the env vars keeps the app
 * driveable from a harness and lets a user force a size.
 */
function useDims() {
  const live = useTerminalDimensions();
  const envW = Number(process.env.COLUMNS);
  const envH = Number(process.env.LINES);
  return () => ({
    width: Number.isFinite(envW) && envW > 0 ? envW : live().width,
    height: Number.isFinite(envH) && envH > 0 ? envH : live().height,
  });
}

function App() {
  const dims = useDims();
  const [sessions] = createResource(() => listSessions());
  const [cursor, setCursor] = createSignal(0);
  const [opened, setOpened] = createSignal<SessionSummary | undefined>();
  const [view, setView] = createSignal<View>("sessions");
  const [agentCursor, setAgentCursor] = createSignal(0);

  const [replay] = createResource(opened, (s) => replaySession(s));

  /** Rows that fit below the header and hint line. */
  const listRows = () => Math.max(3, dims().height - 5);
  /** Scroll the window so the cursor stays visible. */
  const listOffset = () => {
    const n = (sessions() ?? []).length;
    const rows = listRows();
    if (n <= rows) return 0;
    return Math.max(0, Math.min(n - rows, cursor() - Math.floor(rows / 2)));
  };
  const visibleSessions = () =>
    (sessions() ?? []).slice(listOffset(), listOffset() + listRows());

  const headerInfo = () => {
    const s = opened();
    if (!s) return "M1 inspector";
    const r = replay();
    if (!r) return `${s.sessionId.slice(0, 8)} · replaying…`;
    const u = r.usage.current;
    const tok = formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens);
    return `${s.sessionId.slice(0, 8)} · ${agents().length} agents · ${tok} tok · ${r.stats.parsed}/${r.stats.total} lines in ${r.elapsedMs}ms`;
  };

  const agents = () => {
    const r = replay();
    if (!r) return [];
    return r.tree.ordered().filter((n) => n.id !== "root");
  };
  const selected = () => agents()[agentCursor()];

  useKeyboard((key) => {
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) process.exit(0);

    if (view() === "sessions") {
      const list = sessions() ?? [];
      if (name === "down" || name === "j") setCursor((c) => Math.min(list.length - 1, c + 1));
      if (name === "up" || name === "k") setCursor((c) => Math.max(0, c - 1));
      if (name === "return") {
        const s = list[cursor()];
        if (s) { setOpened(s); setAgentCursor(0); setView("tree"); }
      }
      return;
    }

    // Inside a session.
    if (name === "escape") { setView("sessions"); return; }
    if (name === "tab") { setView((v) => (v === "tree" ? "timeline" : "tree")); return; }
    const n = agents().length;
    if (name === "down" || name === "j") setAgentCursor((c) => Math.min(n - 1, c + 1));
    if (name === "up" || name === "k") setAgentCursor((c) => Math.max(0, c - 1));
  });

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
      {/* Header -- one clipped line; OpenTUI will not clip it for us. */}
      <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: C.bgAlt }}>
        <text content=" terminal-helper " style={{ fg: C.accent, flexShrink: 0 }} />
        <text content={fit(headerInfo(), Math.max(0, dims().width - 17))} style={{ fg: C.dim, flexShrink: 0 }} />
      </box>

      {/* Body */}
      <Show
        when={view() !== "sessions"}
        fallback={
          <box style={{ flexDirection: "column", paddingTop: 1 }}>
            <text
              content={fit(
                `  ${(sessions() ?? []).length} sessions  ·  ↑↓ move · ⏎ open · q quit${
                  (sessions() ?? []).length ? `   [${cursor() + 1}/${(sessions() ?? []).length}]` : ""
                }`,
                dims().width,
              )}
              style={{ fg: C.dim }}
            />
            <Show when={sessions()} fallback={<text content="  scanning…" style={{ fg: C.dim }} />}>
              <For each={visibleSessions()}>
                {(s, i) => {
                  const sel = () => i() + listOffset() === cursor();
                  return (
                    <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel() ? C.selBg : undefined }}>
                      <text content={`  ${s.sessionId.slice(0, 8)} `} style={{ fg: sel() ? C.fg : C.dim, flexShrink: 0 }} />
                      <text content={`${(s.sizeBytes / 1e6).toFixed(1).padStart(6)}MB  `} style={{ fg: C.faint, flexShrink: 0 }} />
                      <text
                        content={fit(s.projectSlug.replace(/^-Users-[^-]+-/, ""), Math.max(0, dims().width - 20))}
                        style={{ fg: sel() ? C.accent : C.dim, flexShrink: 0 }}
                      />
                    </box>
                  );
                }}
              </For>
            </Show>
          </box>
        }
      >
        <box style={{ flexDirection: "column", paddingTop: 1 }}>
          <Show when={replay()} fallback={<text content="  replaying…" style={{ fg: C.dim }} />}>
            <text
              content={`  ${view() === "tree" ? "TREE" : "TIMELINE"}  (tab switches · esc back · ↑↓ select)`}
              style={{ fg: C.dim }}
            />
            <Show when={view() === "tree"}>
              <AgentTreeView agents={agents()} selectedId={selected()?.id} width={dims().width} />
            </Show>
            <Show when={view() === "timeline"}>
              <AgentTimeline
                agents={agents()}
                windowStart={replay()!.startedAt ?? 0}
                windowEnd={replay()!.endedAt ?? 1}
                width={dims().width}
                selectedId={selected()?.id}
              />
            </Show>

            {/* Detail strip for the selected agent. */}
            <Show when={selected()}>
              <box style={{ flexDirection: "column", paddingTop: 1 }}>
                <text content={`  ── ${selected()!.name}${selected()!.label ? ` · ${selected()!.label}` : ""}`} style={{ fg: C.accent }} />
                <text
                  content={`     ${selected()!.status}  ${selected()!.model ?? "?"}  ${
                    selected()!.startedAt && selected()!.endedAt
                      ? formatDuration(selected()!.endedAt! - selected()!.startedAt!)
                      : "—"
                  }  ${selected()!.toolCalls.length} tools`}
                  style={{ fg: C.dim }}
                />
                <For each={selected()!.transcript.slice(-3)}>
                  {(e) => (
                    <text
                      content={`     ${e.kind === "thinking" ? "◇" : "·"} ${e.text.replace(/\s+/g, " ").slice(0, dims().width - 10)}`}
                      style={{ fg: e.kind === "thinking" ? C.thinking : C.faint }}
                    />
                  )}
                </For>
              </box>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  );
}

await render(() => <App />, { targetFps: 30 });
