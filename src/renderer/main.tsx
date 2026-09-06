import { createRoot } from "react-dom/client";
import { PopoutWindow } from "./PopoutWindow.js";
import { App } from "./App.js";
import type { ThApi } from "../main/preload.js";

declare global {
  interface Window { th: ThApi }
}

// A window opened with ?popout=<paneId> renders that pane alone; the PTY is
// already running in the main process and is attached to, never restarted.
const popoutPaneId = window.th.popoutPaneId();

createRoot(document.getElementById("root")!).render(
  popoutPaneId ? <PopoutWindow paneId={popoutPaneId} /> : <App />,
);
