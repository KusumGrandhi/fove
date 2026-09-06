/**
 * Model and provider switching.
 *
 * Same-provider switches (Opus ↔ Sonnet ↔ Haiku) are a `/model` command away
 * inside a running Claude Code pane, so this does not reimplement them.
 * What it adds is the part the CLI has no notion of: pointing a *new* pane at a
 * third-party endpoint, and being honest about what that costs.
 *
 * Two rules this UI exists to enforce:
 *
 *   1. Third-party routing is not supported by Anthropic. The notice is quoted
 *      verbatim rather than paraphrased, because paraphrasing a disclaimer is
 *      how it stops being one.
 *   2. A provider whose key is missing is shown as unusable rather than hidden.
 *      Silently omitting it looks like a bug in the app; saying "set
 *      OPENROUTER_API_KEY" is actionable.
 */

import { useCallback, useEffect, useState } from "react";
import { C } from "./Chrome.js";

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  authTokenEnv: string;
  models: string[];
  thirdParty: boolean;
  notes?: string;
  /** Filled in by the main process: is the key actually present? */
  usable?: boolean;
}

export function ModelPicker(props: {
  cwd: string;
  onClose: () => void;
  /** Open a pane running `claude` against this provider. */
  onLaunch: (provider: Provider, model: string) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [notice, setNotice] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = (await window.th.providers()) as { providers: Provider[]; notice: string };
      setProviders(r?.providers ?? []);
      setNotice(r?.notice ?? "");
    })();
  }, []);

  const launch = useCallback(
    (p: Provider, model: string) => {
      if (p.thirdParty && !confirm(
        `Route Claude Code to ${p.label} (${model})?\n\n` +
        `${notice}\n\n` +
        `Prompt caching usually does not apply, so cost and latency can get worse. ` +
        `Extended thinking is often absent and tool-call formatting varies, which ` +
        `shows up as the agentic loop stalling or looping. Token accounting is ` +
        `unreliable, so cost figures are suppressed while this is active.`
      )) return;
      props.onLaunch(p, model);
      props.onClose();
    },
    [notice, props],
  );

  return (
    <div style={S.backdrop} onClick={props.onClose}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={{ color: C.fg }}>Model / provider</span>
          <div style={{ flex: 1 }} />
          <button style={S.ghost} onClick={props.onClose}>close</button>
        </div>

        <div style={S.body}>
          <div style={S.hint}>
            Switching between Claude models inside a running pane is <code>/model</code>.
            These entries start a new pane pointed at a different backend.
          </div>

          {providers.map((p) => (
            <div key={p.id} style={S.provider}>
              <div style={S.providerHead} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                <span style={{ color: p.thirdParty ? "#d29922" : "#3fb950" }}>
                  {p.thirdParty ? "▲" : "●"}
                </span>
                <span style={{ color: C.fg }}>{p.label}</span>
                {p.thirdParty && <span style={S.tag}>third-party</span>}
                {p.thirdParty && p.usable === false && (
                  <span style={S.missing}>set {p.authTokenEnv}</span>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ color: C.faint, fontSize: 10 }}>
                  {p.models.length > 0 ? `${p.models.length} models` : "default"}
                </span>
              </div>

              {openId === p.id && (
                <div style={S.models}>
                  {p.notes && <div style={S.notes}>{p.notes}</div>}
                  {p.models.length === 0 ? (
                    <button style={S.model} onClick={() => launch(p, "")}>
                      open a pane (default model)
                    </button>
                  ) : (
                    p.models.map((m) => (
                      <button
                        key={m}
                        style={{ ...S.model, opacity: p.usable === false ? 0.45 : 1 }}
                        disabled={p.usable === false}
                        title={p.usable === false ? `${p.authTokenEnv} is not set` : m}
                        onClick={() => launch(p, m)}
                      >
                        {m}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}

          {notice && (
            // Quoted, not paraphrased.
            <div style={S.disclaimer}>“{notice}”</div>
          )}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70,
    animation: "fove-fade-in 120ms ease-out",
  },
  panel: {
    width: "min(560px, 92%)", maxHeight: "80%", display: "flex", flexDirection: "column",
    background: "#0d0d11", border: `1px solid ${C.accent}`, borderRadius: 8,
    overflow: "hidden", boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
    fontFamily: "system-ui", fontSize: 12,
    animation: "fove-rise 160ms ease-out",
  },
  head: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
    background: "#15151c", borderBottom: "1px solid #23232c",
  },
  body: { overflow: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 },
  hint: { color: C.faint, fontSize: 11, marginBottom: 4 },
  provider: { border: "1px solid #23232c", borderRadius: 6, overflow: "hidden" },
  providerHead: {
    display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
    background: "#12121a", cursor: "pointer",
  },
  tag: {
    padding: "0 5px", borderRadius: 3, background: "#2a2418", color: "#d29922", fontSize: 10,
  },
  missing: {
    padding: "0 5px", borderRadius: 3, background: "#2a1214", color: "#f85149", fontSize: 10,
  },
  models: { display: "flex", flexWrap: "wrap", gap: 5, padding: "7px 9px", background: "#0d0d11" },
  notes: { width: "100%", color: C.faint, fontSize: 10, marginBottom: 4, lineHeight: 1.5 },
  model: {
    padding: "3px 9px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
  },
  ghost: {
    padding: "3px 10px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
  },
  disclaimer: {
    marginTop: 4, padding: "7px 9px", borderRadius: 5, background: "#1a1712",
    border: "1px solid #3d3527", color: "#d29922", fontSize: 10, lineHeight: 1.6,
  },
};
