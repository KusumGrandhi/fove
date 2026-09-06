/**
 * Config browser: what actually shapes Claude's behaviour, made visible.
 *
 * The skills tab is the point -- it puts each skill's standing context cost
 * next to how often it has ever been invoked, so cost-per-use is a number you
 * can sort by rather than a hunch. Toggling writes skillOverrides to
 * ~/.claude/settings.json; nothing here writes ~/.claude.json.
 */

import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { estTokens, type SkillInfo } from "../data/config/skills.ts";
import type { MemoryFile } from "../data/config/memory.ts";
import { C, fit } from "./theme.ts";

export type ConfigTab = "skills" | "memory" | "mcp";

const overrideLabel = (o: SkillInfo["override"]): string =>
  o === "off" ? "off" : o === "user-invocable-only" ? "manual" : o === "name-only" ? "name" : "on";

const overrideColor = (o: SkillInfo["override"]): string =>
  o === "off" ? C.faint : o === "user-invocable-only" ? C.running : C.done;

export function skillRow(s: SkillInfo, width: number): string {
  const tok = `${estTokens(s.frontmatterBytes)}t`.padStart(6);
  const uses = `${s.usageCount}x`.padStart(5);
  const cpu = s.usageCount === 0 ? "  never" : `${Math.round(estTokens(s.frontmatterBytes) / s.usageCount)}/use`.padStart(7);
  const state = overrideLabel(s.override).padEnd(7);
  const bundle = s.bundle ? `[${s.bundle}] ` : "";
  const nameW = Math.max(10, width - 6 - 5 - 7 - 7 - 6);
  return `${fit(` ${bundle}${s.name}`, nameW)}${tok}${uses}${cpu}  ${state}`;
}

export function ConfigBrowser(props: {
  tab: ConfigTab;
  skills: SkillInfo[];
  memories: MemoryFile[];
  mcp: { name: string; scope: string; project?: string; type?: string }[];
  cursor: number;
  budgetTokens: number;
  enabledCount: number;
  query?: string;
}) {
  const dims = useTerminalDimensions();
  const w = () => dims().width;
  const rows = () => Math.max(3, dims().height - 8);
  const window = <T,>(list: T[]): { items: T[]; offset: number } => {
    const n = list.length, r = rows();
    if (n <= r) return { items: list, offset: 0 };
    const offset = Math.max(0, Math.min(n - r, props.cursor - Math.floor(r / 2)));
    return { items: list.slice(offset, offset + r), offset };
  };

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Show when={props.tab === "skills"}>
        <text
          content={fit(
            `  ${props.enabledCount} skills in the system prompt  ·  ~${props.budgetTokens} tokens every session`,
            w(),
          )}
          style={{ fg: C.accent, flexShrink: 0 }}
        />
        <text
          content={fit("  name                                          cost  uses  per-use  state", w())}
          style={{ fg: C.faint, flexShrink: 0 }}
        />
        {(() => {
          const { items, offset } = window(props.skills);
          return (
            <For each={items}>
              {(s, i) => {
                const sel = () => i() + offset === props.cursor;
                return (
                  <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel() ? C.selBg : undefined }}>
                    <text
                      content={fit(skillRow(s, w()), w())}
                      style={{ fg: sel() ? C.fg : s.usageCount === 0 ? C.dim : overrideColor(s.override), flexShrink: 0 }}
                    />
                  </box>
                );
              }}
            </For>
          );
        })()}
      </Show>

      <Show when={props.tab === "memory"}>
        <text
          content={fit(`  ${props.memories.length} memory files${props.query ? `  ·  filter: ${props.query}` : ""}`, w())}
          style={{ fg: C.accent, flexShrink: 0 }}
        />
        {(() => {
          const { items, offset } = window(props.memories);
          return (
            <For each={items}>
              {(m, i) => {
                const sel = () => i() + offset === props.cursor;
                const proj = m.projectSlug.replace(/^-Users-[^-]+-/, "").slice(0, 22);
                return (
                  <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: sel() ? C.selBg : undefined }}>
                    <text
                      content={fit(
                        ` ${m.isIndex ? "▣" : "·"} ${fit(m.name, 34)}${fit(proj, 24)}${(m.description ?? "").slice(0, Math.max(0, w() - 62))}`,
                        w(),
                      )}
                      style={{ fg: sel() ? C.fg : m.isIndex ? C.accent : C.dim, flexShrink: 0 }}
                    />
                  </box>
                );
              }}
            </For>
          );
        })()}
      </Show>

      <Show when={props.tab === "mcp"}>
        <text content={fit(`  ${props.mcp.length} MCP servers configured`, w())} style={{ fg: C.accent, flexShrink: 0 }} />
        <For each={props.mcp}>
          {(s) => (
            <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
              <text
                content={fit(` ${fit(s.name, 30)}${fit(s.scope, 10)}${fit(s.type ?? "-", 10)}${(s.project ?? "").replace(/^.*\//, "")}`, w())}
                style={{ fg: C.dim, flexShrink: 0 }}
              />
            </box>
          )}
        </For>
        <text content={fit("  (read-only — servers live in ~/.claude.json, which this app never writes)", w())} style={{ fg: C.faint, flexShrink: 0 }} />
      </Show>
    </box>
  );
}
