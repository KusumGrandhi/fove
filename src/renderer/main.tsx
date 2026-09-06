import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { ThApi } from "../main/preload.js";

declare global {
  interface Window { th: ThApi }
}

createRoot(document.getElementById("root")!).render(<App />);
