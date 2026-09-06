/**
 * terminal-helper -- an IDE-grade wrapper for Claude Code.
 *
 * Two modes over one shared model:
 *   LIVE     drives a session through the Agent SDK (M2)
 *   INSPECT  replays a session already on disk (M1)
 *
 * Both produce an AgentTree, so the tree/timeline renderers serve either.
 */

import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { listSessions } from "./data/transcript.ts";
import { replaySession } from "./data/replay.ts";
import { emptyTotals, formatTokens } from "./data/usage.ts";
import { LiveSession, type PermissionRequest } from "./core/session.ts";
import { AgentTimeline } from "./panes/AgentTimeline.tsx";
import { AgentGrid } from "./panes/AgentGrid.tsx";
import { AgentTreeView } from "./panes/AgentTree.tsx";
import { Conversation, type Turn } from "./panes/Conversation.tsx";
import { StatusBar } from "./panes/StatusBar.tsx";
import { ConfigBrowser, type ConfigTab } from "./panes/ConfigBrowser.tsx";
import { Inspector } from "./panes/Inspector.tsx";
import { InspectorProxy, ANTHROPIC } from "./proxy/server.ts";
import { BUILTIN_PROVIDERS, isUsable, tokenFor, type Provider } from "./data/models/thirdParty.ts";
import { readClaudeJson } from "./data/config/claudeJson.ts";
import { listSkills, sortSkills, budget, type SkillSort } from "./data/config/skills.ts";
import { listMemories, filterMemories } from "./data/config/memory.ts";
import { readSettings, setSkillOverride, nextOverride } from "./data/config/settingsFile.ts";
import { C, fit } from "./panes/theme.ts";
import type { SessionSummary } from "./data/types.ts";

type Screen = "sessions" | "inspect" | "live" | "config";
type Pane = "chat" | "grid" | "tree" | "timeline" | "wire";

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
  const [screen, setScreen] = createSignal<Screen>("sessions");
  const [pane, setPane] = createSignal<Pane>("chat");

  // ---- inspect mode -------------------------------------------------------
  const [sessions] = createResource(() => listSessions());
  const [cursor, setCursor] = createSignal(0);
  const [opened, setOpened] = createSignal<SessionSummary | undefined>();
  const [replay] = createResource(opened, (s) => replaySession(s));
  const [agentCursor, setAgentCursor] = createSignal(0);

  // ---- live mode ----------------------------------------------------------
  const [live, setLive] = createSignal<LiveSession | undefined>();
  const [turns, setTurns] = createSignal<Turn[]>([]);
  const [draft, setDraft] = createSignal("");
  const [phase, setPhase] = createSignal("idle");
  const [tick, setTick] = createSignal(0); // forces re-read of mutable session state
  const [perm, setPerm] = createSignal<PermissionRequest | undefined>();

  // ---- proxy / inspector -------------------------------------------------
  const [proxy] = createSignal(new InspectorProxy());
  const [wireOn, setWireOn] = createSignal(false);
  const [wireCursor, setWireCursor] = createSignal(0);
  const [wireDetail, setWireDetail] = createSignal(false);
  const [provider, setProvider] = createSignal<Provider>(BUILTIN_PROVIDERS[0]!);
  const [captureTick, setCaptureTick] = createSignal(0);
  const captures = () => { captureTick(); return proxy().captures.list(); };

  // ---- config browser ----------------------------------------------------
  const [configTab, setConfigTab] = createSignal<ConfigTab>("skills");
  const [configCursor, setConfigCursor] = createSignal(0);
  const [skillSort, setSkillSort] = createSignal<SkillSort>("costPerUse");
  const [configVersion, setConfigVersion] = createSignal(0);
  const [memQuery, setMemQuery] = createSignal("");

  const [configData] = createResource(configVersion, async () => {
    const [cj, settings, memories] = await Promise.all([
      readClaudeJson(),
      readSettings(),
      listMemories(),
    ]);
    const skills = await listSkills({
      usage: cj.skillUsage,
      overrides: (settings.skillOverrides ?? {}) as Record<string, string>,
    });
    return { cj, skills, memories };
  });

  const sortedSkills = () => sortSkills(configData()?.skills ?? [], skillSort());
  const shownMemories = () => filterMemories(configData()?.memories ?? [], memQuery());
  const configBudget = () => budget(configData()?.skills ?? []);

  const listRows = () => Math.max(3, dims().height - 5);
  const listOffset = () => {
    const n = (sessions() ?? []).length;
    const rows = listRows();
    if (n <= rows) return 0;
    return Math.max(0, Math.min(n - rows, cursor() - Math.floor(rows / 2)));
  };
  const visibleSessions = () =>
    (sessions() ?? []).slice(listOffset(), listOffset() + listRows());

  const agents = () => {
    tick();
    const l = live();
    if (screen() === "live" && l) return l.tree.ordered().filter((n) => n.id !== "root");
    const r = replay();
    return r ? r.tree.ordered().filter((n) => n.id !== "root") : [];
  };
  const selected = () => agents()[agentCursor()];
  const usage = () => {
    tick();
    const l = live();
    if (screen() === "live" && l) return l.usage.current;
    return replay()?.usage.current ?? emptyTotals();
  };

  function startLive() {
    // When the inspector is armed we route the session through the local proxy,
    // which is also what makes provider switching seamless later.
    let env: Record<string, string> | undefined;
    if (wireOn()) {
      const p = proxy();
      p.onCapture = () => setCaptureTick((t) => t + 1);
      const base = p.start();
      env = { ANTHROPIC_BASE_URL: base };
    }
    const s = new LiveSession(
      { cwd: process.cwd(), env },
      {
        onPhase: (p) => { setPhase(p); setTick((t) => t + 1); },
        onPermission: (r) => setPerm(r),
        onError: (e) => setTurns((t) => [...t, { role: "system", text: `error: ${e}` }]),
        onMessage: (m) => {
          setTick((t) => t + 1);
          if (m.type === "assistant") {
            const blocks = (m as { message?: { content?: unknown[] } }).message?.content ?? [];
            const agent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
            for (const b of blocks as { type: string; text?: string; name?: string }[]) {
              if (b.type === "text" && b.text?.trim()) {
                setTurns((t) => [...t, {
                  role: "assistant", text: b.text!.trim(),
                  agent: agent ? shortAgent(agent) : undefined,
                }]);
              } else if (b.type === "tool_use") {
                setTurns((t) => [...t, {
                  role: "tool", text: b.name ?? "tool",
                  agent: agent ? shortAgent(agent) : undefined,
                }]);
              }
            }
          }
        },
      },
    );
    s.start();
    setLive(s);
    setScreen("live");
    setPane("chat");
  }

  const shortAgent = (id: string) => {
    const n = live()?.tree.nodes.get(id);
    return n ? (n.label ?? n.name).slice(0, 18) : id.slice(0, 8);
  };

  function submit() {
    const text = draft().trim();
    if (!text) return;
    setTurns((t) => [...t, { role: "user", text }]);
    live()?.send(text);
    setDraft("");
  }

  useKeyboard((key) => {
    const k = key.name;
    const ctrl = key.ctrl;

    // Permission prompt takes precedence over everything.
    const p = perm();
    if (p) {
      if (k === "y" || k === "return") { p.resolve(true); setPerm(undefined); }
      if (k === "n" || k === "escape") { p.resolve(false); setPerm(undefined); }
      return;
    }

    if (ctrl && k === "c") { void live()?.stop(); process.exit(0); }

    if (screen() === "sessions") {
      const list = sessions() ?? [];
      if (k === "down" || k === "j") setCursor((c) => Math.min(list.length - 1, c + 1));
      if (k === "up" || k === "k") setCursor((c) => Math.max(0, c - 1));
      if (k === "q") process.exit(0);
      if (k === "n") { startLive(); return; }
      if (k === "c") { setScreen("config"); setConfigCursor(0); return; }
      if (k === "w") { setWireOn((v) => !v); return; }
      if (k === "return") {
        const s = list[cursor()];
        if (s) { setOpened(s); setAgentCursor(0); setScreen("inspect"); setPane("tree"); }
      }
      return;
    }

    if (screen() === "config") {
      if (k === "escape" || k === "q") { setScreen("sessions"); return; }
      if (k === "tab") {
        setConfigTab((t) => (t === "skills" ? "memory" : t === "memory" ? "mcp" : "skills"));
        setConfigCursor(0);
        return;
      }
      const listLen =
        configTab() === "skills" ? sortedSkills().length
        : configTab() === "memory" ? shownMemories().length
        : configData()?.cj.mcpServers.length ?? 0;
      if (k === "down" || k === "j") setConfigCursor((c) => Math.min(listLen - 1, c + 1));
      if (k === "up" || k === "k") setConfigCursor((c) => Math.max(0, c - 1));
      if (configTab() === "skills") {
        if (k === "s") {
          setSkillSort((v) => (v === "costPerUse" ? "cost" : v === "cost" ? "usage" : v === "usage" ? "name" : "costPerUse"));
          setConfigCursor(0);
        }
        // Space cycles the override and writes settings.json.
        if (k === "space") {
          const sk = sortedSkills()[configCursor()];
          if (sk) {
            void setSkillOverride(sk.name, nextOverride(sk.override)).then(() =>
              setConfigVersion((v) => v + 1),
            );
          }
        }
      }
      return;
    }

    if (screen() === "live") {
      if (ctrl && k === "t") {
        setPane((v) =>
          v === "chat" ? "grid"
          : v === "grid" ? "tree"
          : v === "tree" ? "timeline"
          : wireOn() ? "wire"
          : "chat",
        );
        return;
      }
      if (k === "escape") { void live()?.interrupt(); return; }
      if (pane() === "chat") {
        if (k === "return") { submit(); return; }
        if (k === "backspace") { setDraft((d) => d.slice(0, -1)); return; }
        if (key.sequence && key.sequence.length === 1 && !ctrl) {
          setDraft((d) => d + key.sequence);
        }
        return;
      }
      if (pane() === "wire") {
        const n = captures().length;
        if (k === "down" || k === "j") setWireCursor((c) => Math.min(n - 1, c + 1));
        if (k === "up" || k === "k") setWireCursor((c) => Math.max(0, c - 1));
        if (k === "return") setWireDetail((d) => !d);
        if (k === "p") {
          // Cycle provider. The proxy reroutes on the next request, so the
          // conversation, agent tree and cost history all stay put.
          const usable = BUILTIN_PROVIDERS.filter(isUsable);
          const idx = usable.findIndex((x) => x.id === provider().id);
          const next = usable[(idx + 1) % usable.length]!;
          setProvider(next);
          proxy().setUpstream(
            next.thirdParty
              ? { baseUrl: next.baseUrl, authToken: tokenFor(next), thirdParty: true, label: next.label }
              : ANTHROPIC,
          );
        }
        return;
      }
      const n = agents().length;
      if (k === "down" || k === "j") setAgentCursor((c) => Math.min(n - 1, c + 1));
      if (k === "up" || k === "k") setAgentCursor((c) => Math.max(0, c - 1));
      if (k === "x") {
        // Per-agent interrupt: mark it stopped locally. The SDK has no
        // per-subagent kill, so this reflects intent in the UI and stops the
        // tile updating; the turn-level interrupt is still esc.
        const a = selected();
        if (a && a.status === "running") { a.status = "error"; setTick((t) => t + 1); }
      }
      return;
    }

    // inspect
    if (k === "escape") { setScreen("sessions"); return; }
    if (k === "q") process.exit(0);
    if (k === "tab") { setPane((v) => (v === "tree" ? "timeline" : "tree")); return; }
    const n = agents().length;
    if (k === "down" || k === "j") setAgentCursor((c) => Math.min(n - 1, c + 1));
    if (k === "up" || k === "k") setAgentCursor((c) => Math.max(0, c - 1));
  });

  const header = () => {
    if (screen() === "live") {
      tick();
      const l = live();
      return `LIVE  ${l?.sessionId?.slice(0, 8) ?? "starting…"}  ${process.cwd().replace(/^.*\//, "")}`;
    }
    if (screen() === "config") return "CONFIG  ·  what shapes Claude's behaviour";
    const s = opened();
    if (!s) return "⏎ inspect · n live session · c config";
    const r = replay();
    if (!r) return `${s.sessionId.slice(0, 8)} · replaying…`;
    const u = r.usage.current;
    const tok = formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens);
    return `${s.sessionId.slice(0, 8)} · ${agents().length} agents · ${tok} tok · ${r.stats.parsed}/${r.stats.total} lines in ${r.elapsedMs}ms`;
  };

  const bodyRows = () => Math.max(3, dims().height - 6);

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
      <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: C.bgAlt }}>
        <text content=" terminal-helper " style={{ fg: C.accent, flexShrink: 0 }} />
        <text content={fit(header(), Math.max(0, dims().width - 17))} style={{ fg: C.dim, flexShrink: 0 }} />
      </box>

      {/* ---- session picker ---- */}
      <Show when={screen() === "sessions"}>
        <box style={{ flexDirection: "column", width: "100%" }}>
          <text
            content={fit(`  ${(sessions() ?? []).length} sessions  ·  ⏎ inspect · n live · c config · w wire${wireOn() ? " ON" : ""} · q quit  [${cursor() + 1}/${(sessions() ?? []).length || 1}]`, dims().width)}
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
                    <text content={fit(s.projectSlug.replace(/^-Users-[^-]+-/, ""), Math.max(0, dims().width - 20))} style={{ fg: sel() ? C.accent : C.dim, flexShrink: 0 }} />
                  </box>
                );
              }}
            </For>
          </Show>
        </box>
      </Show>

      {/* ---- live ---- */}
      <Show when={screen() === "live"}>
        <box style={{ flexDirection: "column", width: "100%" }}>
          <text
            content={fit(
              `  ${pane().toUpperCase()}  ·  ^t pane · ${
                pane() === "chat" ? "⏎ send"
                : pane() === "wire" ? "↑↓ select · ⏎ detail · p provider"
                : "↑↓ select · x stop"
              } · esc stop · ^c quit`,
              dims().width,
            )}
            style={{ fg: C.dim }}
          />
          <Show when={pane() === "chat"}>
            <Conversation turns={turns()} maxLines={bodyRows() - 2} />
            <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
              <text content=" ❯ " style={{ fg: C.accent, flexShrink: 0 }} />
              <text content={fit(draft() + "▏", Math.max(0, dims().width - 3))} style={{ fg: C.fg, flexShrink: 0 }} />
            </box>
          </Show>
          <Show when={pane() === "grid"}>
            <AgentGrid agents={agents()} selectedId={selected()?.id} height={bodyRows()} />
          </Show>
          <Show when={pane() === "wire"}>
            <Inspector
              captures={captures()}
              cursor={wireCursor()}
              detail={wireDetail()}
              upstream={provider().label}
              thirdParty={provider().thirdParty}
            />
          </Show>
          <Show when={pane() === "tree"}>
            <AgentTreeView agents={agents()} selectedId={selected()?.id} />
          </Show>
          <Show when={pane() === "timeline"}>
            <AgentTimeline agents={agents()} windowStart={liveStart()} windowEnd={Date.now()} selectedId={selected()?.id} />
          </Show>
        </box>
      </Show>

      {/* ---- inspect ---- */}
      <Show when={screen() === "inspect"}>
        <box style={{ flexDirection: "column", width: "100%" }}>
          <Show when={replay()} fallback={<text content="  replaying…" style={{ fg: C.dim }} />}>
            <text content={fit(`  ${pane() === "timeline" ? "TIMELINE" : "TREE"}  ·  tab switches · esc back · ↑↓ select`, dims().width)} style={{ fg: C.dim }} />
            <Show when={pane() !== "timeline"}>
              <AgentTreeView agents={agents()} selectedId={selected()?.id} />
            </Show>
            <Show when={pane() === "timeline"}>
              <AgentTimeline agents={agents()} windowStart={replay()!.startedAt ?? 0} windowEnd={replay()!.endedAt ?? 1} selectedId={selected()?.id} />
            </Show>
          </Show>
        </box>
      </Show>

      {/* ---- config browser ---- */}
      <Show when={screen() === "config"}>
        <box style={{ flexDirection: "column", width: "100%" }}>
          <text
            content={fit(
              `  ${configTab().toUpperCase()}  ·  tab switches${
                configTab() === "skills" ? `  ·  space toggles  ·  s sort (${skillSort()})` : ""
              }  ·  esc back`,
              dims().width,
            )}
            style={{ fg: C.dim }}
          />
          <Show when={configData()} fallback={<text content="  loading config…" style={{ fg: C.dim }} />}>
            <ConfigBrowser
              tab={configTab()}
              skills={sortedSkills()}
              memories={shownMemories()}
              mcp={configData()!.cj.mcpServers}
              cursor={configCursor()}
              budgetTokens={configBudget().tokens}
              enabledCount={configBudget().enabled}
              query={memQuery()}
            />
          </Show>
        </box>
      </Show>

      {/* ---- permission prompt ---- */}
      <Show when={perm()}>
        <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: C.selBg }}>
          <text content={fit(` allow ${perm()!.toolName}?  [y] allow   [n] deny `, dims().width)} style={{ fg: C.running, flexShrink: 0 }} />
        </box>
      </Show>

      <Show when={screen() !== "sessions"}>
        <StatusBar
          model={live()?.model}
          phase={screen() === "live" ? phase() : "replay"}
          usage={usage()}
          apiKeySource={live()?.apiKeySource}
          agents={agents().length}
        />
      </Show>
    </box>
  );

  function liveStart(): number {
    const nodes = agents();
    const times = nodes.map((n) => n.startedAt).filter((t): t is number => t !== undefined);
    return times.length ? Math.min(...times) : Date.now() - 1000;
  }
}

await render(() => <App />, { targetFps: 30 });
