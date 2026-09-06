/** Bottom status bar: model, phase, tokens, cost, cache. */

import { Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { costIsMeaningful, formatTokens, type UsageTotals } from "../data/usage.ts";
import { C, fit } from "./theme.ts";

export function statusText(a: {
  model?: string;
  phase: string;
  usage: UsageTotals;
  apiKeySource?: string;
  agents: number;
  thirdParty?: boolean;
}): string {
  const parts: string[] = [];
  parts.push((a.model ?? "—").replace("claude-", ""));
  parts.push(a.phase);
  const u = a.usage;
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  parts.push(`${formatTokens(total)} tok`);
  const cacheDenom = u.cacheReadTokens + u.inputTokens + u.cacheCreationTokens;
  if (cacheDenom > 0) {
    parts.push(`cache ${Math.round((u.cacheReadTokens / cacheDenom) * 100)}%`);
  }
  // Dollars only when an API key is actually the billing path.
  if (costIsMeaningful({
    usingApiKey: a.apiKeySource !== undefined && a.apiKeySource !== "none",
    thirdPartyProvider: a.thirdParty === true,
  })) {
    parts.push(`~$${u.costUSD.toFixed(4)}`);
  } else if (u.costUSD > 0) {
    parts.push("subscription");
  }
  if (a.agents > 0) parts.push(`${a.agents} agents`);
  return ` ${parts.join("  ·  ")}`;
}

export function StatusBar(props: {
  model?: string;
  phase: string;
  usage: UsageTotals;
  apiKeySource?: string;
  agents: number;
  hint?: string;
}) {
  const dims = useTerminalDimensions();
  return (
    <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, backgroundColor: C.bgAlt }}>
      <text
        content={fit(statusText(props), Math.max(0, dims().width - (props.hint?.length ?? 0)))}
        style={{ fg: C.dim, flexShrink: 0 }}
      />
      <Show when={props.hint}>
        <text content={props.hint!} style={{ fg: C.faint, flexShrink: 0 }} />
      </Show>
    </box>
  );
}
