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
import { C } from "./panes/theme.ts";
import type { SessionSummary } from "./data/types.ts";

type View = "sessions" | "tree" | "timeline";

function App() {
  const dims = useTerminalDimensions();
  const [sessions] = createResource(() => listSessions());
  const [cursor, setCursor] = createSignal(0);
  const [opened, setOpened] = createSignal<SessionSummary | undefined>();
  const [view, setView] = createSignal<View>("sessions");
  const [agentCursor, setAgentCursor] = createSignal(0);

  const [replay] = createResource(opened, (s) => replaySession(s));

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
      {/* Header */}
      <box style={{ flexDirection: "row", backgroundColor: C.bgAlt }}>
        <text content=" terminal-helper " style={{ fg: C.accent }} />
        <text content={`M1 inspector `} style={{ fg: C.dim }} />
        <Show when={opened()}>
          <text content={`│ ${opened()!.sessionId.slice(0, 8)} `} style={{ fg: C.fg }} />
          <Show when={replay()}>
            <text
              content={`│ ${agents().length} agents │ ${formatTokens(
                replay()!.usage.current.inputTokens +
                  replay()!.usage.current.cacheReadTokens +
                  replay()!.usage.current.cacheCreationTokens,
              )} tok │ parsed ${replay()!.stats.parsed}/${replay()!.stats.total} in ${replay()!.elapsedMs}ms `}
              style={{ fg: C.dim }}
            />
          </Show>
        </Show>
      </box>

      {/* Body */}
      <Show
        when={view() !== "sessions"}
        fallback={
          <box style={{ flexDirection: "column", paddingTop: 1 }}>
            <text content="  Sessions on this machine (↑↓ move · ⏎ open · q quit)" style={{ fg: C.dim }} />
            <Show when={sessions()} fallback={<text content="  scanning…" style={{ fg: C.dim }} />}>
              <For each={(sessions() ?? []).slice(0, Math.max(5, dims().height - 6))}>
                {(s, i) => {
                  const sel = () => i() === cursor();
                  return (
                    <box style={{ flexDirection: "row", backgroundColor: sel() ? C.selBg : undefined }}>
                      <text content={`  ${s.sessionId.slice(0, 8)} `} style={{ fg: sel() ? C.fg : C.dim }} />
                      <text content={`${(s.sizeBytes / 1e6).toFixed(1).padStart(5)}MB  `} style={{ fg: C.faint }} />
                      <text content={s.projectSlug.replace(/^-Users-[^-]+-/, "").slice(0, 52)} style={{ fg: sel() ? C.accent : C.dim }} />
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
