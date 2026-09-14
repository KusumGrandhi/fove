/**
 * Model and provider switching.
 *
 * Same-provider switches (Opus ↔ Sonnet ↔ Haiku) are a `/model` command away
 * inside a running Claude Code pane, so this does not reimplement them.
 * What it adds is the part the CLI has no notion of: pointing a *new* pane at a
 * third-party endpoint, and being honest about what that costs.
 *
 * Three rules this UI exists to enforce:
 *
 *   1. Third-party routing is not supported by Anthropic. The notice is quoted
 *      verbatim rather than paraphrased, because paraphrasing a disclaimer is
 *      how it stops being one.
 *   2. A provider whose key is missing is shown as unusable rather than hidden.
 *      Silently omitting it looks like a bug in the app; saying "set
 *      OPENROUTER_API_KEY" is actionable -- but only just, since a Dock-launched
 *      app never sees a shell export. So the chip is a button that takes the key
 *      here and has the main process save it to the OS keychain.
 *   3. The key never comes back. The renderer learns whether one exists and
 *      where it came from, never its value -- so a key the user exported is
 *      reported but not offered for deletion, because it isn't ours to delete.
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
  /** Where that key came from, so only a key this app saved offers "forget". */
  keySource?: "env" | "stored" | null;
}

export interface DefaultModel {
  providerId: string;
  model: string;
}

export function ModelPicker(props: {
  cwd: string;
  onClose: () => void;
  /** Open a pane running `claude` against this provider. */
  onLaunch: (provider: Provider, model: string) => void;
  /** Re-read the saved default, which lives in the main process. */
  onDefaultChanged?: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [notice, setNotice] = useState<string>("");
  const [def, setDef] = useState<DefaultModel | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const r = (await window.th.providers()) as {
      providers: Provider[];
      notice: string;
      default: DefaultModel | null;
    };
    setProviders(r?.providers ?? []);
    setNotice(r?.notice ?? "");
    setDef(r?.default ?? null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveKey = useCallback(async (p: Provider) => {
    setError("");
    const res = await window.th.providerSetKey(p.authTokenEnv, draft);
    if (!res?.ok) { setError(res?.error ?? "Could not save the key."); return; }
    // Held only long enough to hand it to the main process.
    setDraft("");
    setEditing(null);
    await refresh();
  }, [draft, refresh]);

  const forgetKey = useCallback(async (p: Provider) => {
    await window.th.providerClearKey(p.authTokenEnv);
    await refresh();
  }, [refresh]);

  const makeDefault = useCallback(async (p: Provider, model: string) => {
    const isDef = def?.providerId === p.id && def?.model === model;
    await window.th.providerSetDefault(isDef ? null : { providerId: p.id, model });
    await refresh();
    props.onDefaultChanged?.();
  }, [def, refresh, props]);

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

  /** The key chip doubles as the control that sets one, so it is always a button. */
  const keyChip = (p: Provider) => {
    if (!p.thirdParty) return null;
    if (p.keySource === "env") {
      return <span style={S.fromEnv} title={`${p.authTokenEnv} is set in this app's environment`}>key from env</span>;
    }
    if (p.keySource === "stored") {
      return (
        <span style={S.saved} title="Saved in the OS keychain">
          key saved
          <button
            style={S.linkBtn}
            onClick={(e) => { e.stopPropagation(); void forgetKey(p); }}
          >forget</button>
        </span>
      );
    }
    return (
      <button
        style={S.missing}
        title={`${p.authTokenEnv} is not set -- click to add it`}
        onClick={(e) => {
          e.stopPropagation();
          setOpenId(p.id);
          setEditing(editing === p.id ? null : p.id);
          setDraft("");
          setError("");
        }}
      >set {p.authTokenEnv}</button>
    );
  };

  const starFor = (p: Provider, model: string) => {
    const isDef = def?.providerId === p.id && def?.model === model;
    return (
      <button
        style={{ ...S.star, color: isDef ? "#d29922" : "#4a4a57" }}
        title={isDef ? "Default for new claude panes -- click to unset" : "Make this the default for new claude panes"}
        onClick={(e) => { e.stopPropagation(); void makeDefault(p, model); }}
      >★</button>
    );
  };

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
            These entries start a new pane pointed at a different backend; ★ makes one
            the default every new claude pane starts on.
          </div>

          {providers.map((p) => (
            <div key={p.id} style={S.provider}>
              <div style={S.providerHead} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                <span style={{ color: p.thirdParty ? "#d29922" : "#3fb950" }}>
                  {p.thirdParty ? "▲" : "●"}
                </span>
                <span style={{ color: C.fg }}>{p.label}</span>
                {p.thirdParty && <span style={S.tag}>third-party</span>}
                {keyChip(p)}
                {def?.providerId === p.id && <span style={S.defTag}>default</span>}
                <div style={{ flex: 1 }} />
                <span style={{ color: C.faint, fontSize: 10 }}>
                  {p.models.length > 0 ? `${p.models.length} models` : "default"}
                </span>
              </div>

              {editing === p.id && (
                <div style={S.keyRow}>
                  <input
                    type="password"
                    autoFocus
                    value={draft}
                    placeholder={`${p.authTokenEnv} value`}
                    style={S.input}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveKey(p);
                      if (e.key === "Escape") { setEditing(null); setDraft(""); }
                    }}
                  />
                  <button style={S.model} onClick={() => void saveKey(p)}>save</button>
                  <button style={S.ghost} onClick={() => { setEditing(null); setDraft(""); }}>cancel</button>
                  <div style={S.keyNote}>
                    Encrypted with the OS keychain and remembered across restarts. An
                    exported {p.authTokenEnv} still takes precedence.
                  </div>
                  {error && <div style={S.error}>{error}</div>}
                </div>
              )}

              {openId === p.id && (
                <div style={S.models}>
                  {p.notes && <div style={S.notes}>{p.notes}</div>}
                  {p.models.length === 0 ? (
                    <span style={S.chipGroup}>
                      <button style={S.model} onClick={() => launch(p, "")}>
                        open a pane (default model)
                      </button>
                      {starFor(p, "")}
                    </span>
                  ) : (
                    p.models.map((m) => (
                      <span key={m} style={S.chipGroup}>
                        <button
                          style={{ ...S.model, opacity: p.usable === false ? 0.45 : 1 }}
                          disabled={p.usable === false}
                          title={p.usable === false ? `${p.authTokenEnv} is not set` : `open a pane on ${m}`}
                          onClick={() => launch(p, m)}
                        >
                          {m}
                        </button>
                        {starFor(p, m)}
                      </span>
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
  defTag: {
    padding: "0 5px", borderRadius: 3, background: "#2a2418", color: "#d29922",
    fontSize: 10, border: "1px solid #3d3527",
  },
  missing: {
    padding: "0 5px", borderRadius: 3, background: "#2a1214", color: "#f85149", fontSize: 10,
    border: "1px solid #4a1f22", cursor: "pointer", fontFamily: "inherit",
  },
  saved: {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "0 5px", borderRadius: 3, background: "#122a19", color: "#3fb950", fontSize: 10,
  },
  fromEnv: {
    padding: "0 5px", borderRadius: 3, background: "#16202a", color: "#58a6ff", fontSize: 10,
  },
  linkBtn: {
    background: "transparent", border: "none", padding: 0, cursor: "pointer",
    color: C.faint, fontSize: 10, textDecoration: "underline", fontFamily: "inherit",
  },
  keyRow: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5,
    padding: "7px 9px", background: "#0d0d11", borderTop: "1px solid #23232c",
  },
  input: {
    flex: 1, minWidth: 220, padding: "4px 7px", borderRadius: 4,
    border: "1px solid #33333d", background: "#08080b", color: C.fg,
    fontSize: 11, fontFamily: "inherit",
  },
  keyNote: { width: "100%", color: C.faint, fontSize: 10, lineHeight: 1.5 },
  error: { width: "100%", color: "#f85149", fontSize: 10, lineHeight: 1.5 },
  models: { display: "flex", flexWrap: "wrap", gap: 5, padding: "7px 9px", background: "#0d0d11" },
  notes: { width: "100%", color: C.faint, fontSize: 10, marginBottom: 4, lineHeight: 1.5 },
  chipGroup: { display: "inline-flex", alignItems: "center", gap: 2 },
  model: {
    padding: "3px 9px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
    fontFamily: "inherit",
  },
  star: {
    padding: "3px 4px", border: "none", background: "transparent",
    fontSize: 11, cursor: "pointer", lineHeight: 1,
  },
  ghost: {
    padding: "3px 10px", borderRadius: 4, border: "1px solid #33333d",
    background: "transparent", color: C.fg, fontSize: 11, cursor: "pointer",
    fontFamily: "inherit",
  },
  disclaimer: {
    marginTop: 4, padding: "7px 9px", borderRadius: 5, background: "#1a1712",
    border: "1px solid #3d3527", color: "#d29922", fontSize: 10, lineHeight: 1.6,
  },
};
