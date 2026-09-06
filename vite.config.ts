import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Monaco loads its language services as web workers. Declaring them as extra
 * inputs lets Vite bundle each one; the renderer points MonacoEnvironment at
 * the built files. Without this, the editor works but every language feature
 * (syntax errors, formatting, suggestions) silently does nothing.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: "es" },
});
