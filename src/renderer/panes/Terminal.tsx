/**
 * A pane hosting a real terminal: xterm.js in the renderer, a PTY in main.
 *
 * The xterm instance is created once per pane and kept across re-renders. On
 * mount it asks main for the PTY; if one already exists (the pane was moved or
 * remounted) main replays the scrollback so nothing is lost.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPaneProps {
  paneId: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  /** Extra environment, e.g. a third-party provider's base URL. */
  env?: Record<string, string>;
  focused: boolean;
  onExit?: (code: number) => void;
  onTitle?: (title: string) => void;
}

/**
 * xterm paints to a canvas and cannot read CSS variables, so it needs the
 * theme's literal values. `activeTheme()` reads whichever theme is applied
 * rather than hard-coding one.
 */
function termTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    css.getPropertyValue(`--fove-${name}`).trim() || fallback;
  return {
    background: get("panel", "#0d0d11"),
    foreground: get("fg", "#d8d8dc"),
    cursor: get("accent", "#00a0ff"),
    selectionBackground: "#264f78",
  };
}

export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const offData = window.th.onData((id, data) => {
      if (id === props.paneId) term.write(data);
    });
    const offExit = window.th.onExit((id, code) => {
      if (id !== props.paneId) return;
      term.write(`\r\n\x1b[2m[process exited ${code}]\x1b[0m\r\n`);
      props.onExit?.(code);
    });

    term.onData((d) => window.th.input(props.paneId, d));
    term.onTitleChange((t) => props.onTitle?.(t));

    // Size to the container before spawning, so the shell starts correct.
    const boot = async () => {
      try {
        fit.fit();
      } catch {
        // Container not laid out yet; the observer below will correct it.
      }
      const { fresh, scrollback } = await window.th.spawn({
        paneId: props.paneId,
        cmd: props.cmd,
        args: props.args,
        cwd: props.cwd,
        env: props.env,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) return;
      if (!fresh && scrollback) term.write(scrollback);
      window.th.resize(props.paneId, term.cols, term.rows);
    };
    void boot();

    // Keep the PTY's window size in step with the pane's.
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
        window.th.resize(props.paneId, term.cols, term.rows);
      } catch {
        // Zero-size during a drag; ignored.
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
    };
    // Bound to the pane's identity: a different pane is a different terminal.
  }, [props.paneId]);

  useEffect(() => {
    if (props.focused) termRef.current?.focus();
  }, [props.focused]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />;
}
