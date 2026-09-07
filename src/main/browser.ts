/**
 * A browser pane, for testing the thing you are changing without leaving fove.
 *
 * Electron *is* Chromium, so this needs no dependency -- but it is also the one
 * feature that puts untrusted code in the process, so the isolation is not
 * optional decoration:
 *
 *   - `nodeIntegration: false` and `contextIsolation: true`, so a page cannot
 *     reach Node.
 *   - **No preload.** Every other view in fove loads one to get `window.th`;
 *     handing that bridge to an arbitrary page would expose the filesystem and
 *     the PTYs to whatever it is you are testing.
 *   - A **separate session partition**, so a page's cookies and storage are not
 *     shared with the app, and clearing them cannot disturb it.
 *   - `window.open` is refused and sent to the system browser instead. A popup
 *     opening as a chromeless Electron window with unknown preferences is the
 *     classic way this kind of pane becomes a hole.
 *
 * A `WebContentsView` is a native view, not a DOM element: it does not live in
 * the renderer's tree and knows nothing about the split layout. So the renderer
 * reports where the pane *is* and this service positions the view over it. That
 * is the whole reason for `setBounds` traffic, and the reason a hidden pane
 * must be explicitly hidden -- a native view has no z-index and would otherwise
 * paint straight over the rest of the app.
 *
 * The capture buffers are what make this *inline testing* rather than a browser
 * bolted on: the console errors and failed requests are readable by Claude
 * through the IDE server, so "why is this page broken" is answerable without
 * copy-paste.
 */

import { WebContentsView, shell, type BaseWindow } from "electron";

export interface ConsoleEntry {
  /** Chromium's own levels, passed through rather than remapped. */
  level: "info" | "warning" | "error" | "debug";
  text: string;
  source?: string;
  line?: number;
  at: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  /** Set when the request failed outright rather than returning a status. */
  error?: string;
  at: number;
}

export interface Bounds { x: number; y: number; width: number; height: number }

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Bounded, because a page in a reload loop would otherwise grow these without
 * limit. The recent entries are the useful ones.
 */
const MAX_CONSOLE = 500;
const MAX_NETWORK = 300;

/** Only these schemes may be loaded from the URL bar. */
const SAFE_SCHEMES = new Set(["http:", "https:", "about:"]);

/**
 * Normalize what the user typed into a URL.
 *
 * A bare host is the common case ("localhost:5000"), and rejecting it would
 * make the URL bar feel broken. `file:` is deliberately not accepted: this view
 * has no preload and no node access, but pointing it at the filesystem is still
 * a category of thing this pane should not do.
 *
 * The scheme test requires a non-digit after the colon, because `localhost:5000`
 * is otherwise indistinguishable from a scheme named "localhost" -- and that is
 * the single most likely thing to be typed here, the Flask dev server.
 */
export function toUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text);
  const withScheme = hasScheme ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

interface Pane {
  view: WebContentsView;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  visible: boolean;
}

export class BrowserService {
  private readonly panes = new Map<string, Pane>();

  constructor(
    private readonly window: () => BaseWindow | null,
    /** Tells the renderer a pane's url/title/loading changed. */
    private readonly onState: (paneId: string, state: BrowserState) => void,
  ) {}

  /** Create the view for a pane, or return the one it already has. */
  private ensure(paneId: string): Pane {
    const found = this.panes.get(paneId);
    if (found) return found;

    const view = new WebContentsView({
      webPreferences: {
        // See the file comment: none of these three is negotiable.
        nodeIntegration: false,
        contextIsolation: true,
        // A partition per pane, in memory: closing the pane forgets the
        // session, which is what you want when testing a login flow twice.
        partition: `fove-browser-${paneId}`,
        // Chromium's own protection against a page reading cross-origin
        // resources it should not.
        webSecurity: true,
      },
    });

    const pane: Pane = { view, console: [], network: [], visible: false };
    this.panes.set(paneId, pane);
    this.wire(paneId, pane);

    const win = this.window();
    win?.contentView.addChildView(view);
    // Nothing is laid out yet; keep it off-screen until the renderer reports
    // where the pane actually is.
    view.setVisible(false);
    return pane;
  }

  private wire(paneId: string, pane: Pane): void {
    const wc = pane.view.webContents;

    // A popup would open as a window with preferences we did not choose, so
    // hand it to the system browser instead.
    wc.setWindowOpenHandler(({ url }) => {
      if (toUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    wc.on("console-message", (event) => {
      // Electron injects its own security warnings into every page it loads.
      // They are about *this app's* configuration, not the page's code, and
      // letting one through would hand Claude a problem the user cannot fix
      // in the code they are looking at.
      if (isElectronNoise(event.message, event.sourceId)) return;
      push(pane.console, MAX_CONSOLE, {
        level: event.level,
        text: event.message,
        source: event.sourceId,
        line: event.lineNumber,
        at: Date.now(),
      });
    });

    const emit = (): void => this.onState(paneId, this.state(paneId)!);
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("page-title-updated", emit);
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);

    wc.on("did-fail-load", (_e, code, desc, url) => {
      // -3 is ABORTED, which is what a normal navigation away looks like.
      if (code === -3) return;
      push(pane.network, MAX_NETWORK, { url, method: "GET", error: desc, at: Date.now() });
      emit();
    });

    // Request-level capture. `webRequest` is per session, and each pane has its
    // own, so these listeners never see another pane's traffic.
    const session = wc.session;
    session.webRequest.onCompleted((details) => {
      // A 200 is not interesting; failures are the reason this pane exists.
      if (details.statusCode < 400) return;
      push(pane.network, MAX_NETWORK, {
        url: details.url,
        method: details.method,
        status: details.statusCode,
        at: Date.now(),
      });
    });
    session.webRequest.onErrorOccurred((details) => {
      push(pane.network, MAX_NETWORK, {
        url: details.url,
        method: details.method,
        error: details.error,
        at: Date.now(),
      });
    });
  }

  /** Load a URL, rejecting anything that is not http(s). */
  navigate(paneId: string, input: string): string | null {
    const url = toUrl(input);
    if (!url) return null;
    const pane = this.ensure(paneId);
    void pane.view.webContents.loadURL(url);
    return url;
  }

  /**
   * Position the view over where the renderer says the pane is.
   *
   * Also the visibility control: a pane scrolled out of view or in a background
   * tab reports no bounds, and a native view with no z-index would otherwise
   * paint over the app.
   */
  setBounds(paneId: string, bounds: Bounds | null): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      pane.visible = false;
      pane.view.setVisible(false);
      return;
    }
    pane.view.setBounds({
      // Fractional bounds from a CSS layout would blur the whole page.
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    pane.visible = true;
    pane.view.setVisible(true);
  }

  back(paneId: string): void {
    const wc = this.panes.get(paneId)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(paneId: string): void {
    const wc = this.panes.get(paneId)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  /** `hard` bypasses the cache, which is the one you want after a rebuild. */
  reload(paneId: string, hard = false): void {
    const wc = this.panes.get(paneId)?.view.webContents;
    if (!wc) return;
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  openDevTools(paneId: string): void {
    // Detached, because the view is sized to the pane and docked tools would
    // squeeze the page into nothing.
    this.panes.get(paneId)?.view.webContents.openDevTools({ mode: "detach" });
  }

  state(paneId: string): BrowserState | null {
    const pane = this.panes.get(paneId);
    if (!pane) return null;
    const wc = pane.view.webContents;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  console(paneId: string): ConsoleEntry[] {
    return this.panes.get(paneId)?.console ?? [];
  }

  network(paneId: string): NetworkEntry[] {
    return this.panes.get(paneId)?.network ?? [];
  }

  clear(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.console.length = 0;
    pane.network.length = 0;
  }

  /**
   * Every pane's problems, for the IDE tool Claude calls.
   *
   * Only errors and failed requests: a page's `console.log` noise is not what
   * "why is this broken" is asking about, and filling a model's context with it
   * would make the answer worse.
   */
  problems(): { paneId: string; url: string; console: ConsoleEntry[]; network: NetworkEntry[] }[] {
    return [...this.panes.entries()].map(([paneId, pane]) => ({
      paneId,
      url: pane.view.webContents.getURL(),
      console: pane.console.filter((c) => c.level === "error"),
      network: pane.network,
    }));
  }

  close(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    this.panes.delete(paneId);
    const win = this.window();
    // Removing the child view first: destroying a view still attached to the
    // window leaves the window holding a dead child.
    try { win?.contentView.removeChildView(pane.view); } catch { /* window gone */ }
    pane.view.webContents.close();
  }

  closeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id);
  }
}

/**
 * Whether a console line came from Electron rather than from the page.
 *
 * Matched on the source as well as the text: `sandbox_bundle` is Electron's
 * own injected script, and nothing a page author writes lives there.
 */
export function isElectronNoise(message: string, source: string): boolean {
  if (source.startsWith("sandbox_bundle")) return true;
  return message.includes("Electron Security Warning");
}

/** Append, dropping the oldest once the cap is reached. */
function push<T>(list: T[], max: number, entry: T): void {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}
