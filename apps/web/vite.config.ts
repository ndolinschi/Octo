import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
// @ts-expect-error node globals are not typed in this project
const port = Number(process.env.OCTO_WEB_PORT) || 1430;

/**
 * The phone's client (spec 2026-11-14-remote-access-mobile-design.md): `@octo/ui` built as static files that the harness
 * serves at the tunnel root (`HARNESS_REMOTE_WEB_DIR=apps/web/dist`). Same-origin with the API, so no bridge URL is baked in.
 * In development the harness proxies to this server (`HARNESS_REMOTE_WEB_PROXY=http://127.0.0.1:1430`).
 */
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@octo/ui": path.resolve(rootDir, "../../packages/ui/src"),
      "@octo/agent-client": path.resolve(rootDir, "../../packages/agent-client/src"),
    },
  },
  clearScreen: false,
  server: { port, strictPort: true, host: "127.0.0.1" },
  preview: { port, strictPort: true, host: "127.0.0.1" },
}));
