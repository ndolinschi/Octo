import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
// @ts-expect-error set by Tauri during mobile dev
const host = process.env.TAURI_DEV_HOST as string | undefined;

// `scripts/dev.sh` moves the dev server when 1420 is busy; `tauri dev` always uses the default (its devUrl).
// @ts-expect-error node globals are not typed in this project
const uiPort = Number(process.env.OCTO_DEV_UI_PORT) || 1420;

/**
 * The chunks the page loads at start (the entry and everything it imports statically), collected before Vite writes the
 * preload lists of the dynamic imports: by the time any `import()` runs they are all loaded, so listing them again in every
 * lazy chunk's preload list only adds bytes to the entry (`__vite__mapDeps`). `resolveDependencies` below leaves them out.
 */
const initialChunks = new Set<string>();
const collectInitialChunks: Plugin = {
  name: "octo:initial-chunks",
  generateBundle: {
    order: "pre",
    handler(_options, bundle) {
      initialChunks.clear();
      const visit = (file: string) => {
        const chunk = bundle[file];
        if (initialChunks.has(file) || chunk?.type !== "chunk") return;
        initialChunks.add(file);
        chunk.imports.forEach(visit);
      };
      for (const [file, chunk] of Object.entries(bundle)) if (chunk.type === "chunk" && chunk.isEntry) visit(file);
    },
  },
};

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), collectInitialChunks],
  build: {
    modulePreload: {
      // Only for preloads written into JS: the HTML keeps its own modulepreload links.
      resolveDependencies: (_file: string, deps: string[], context: { hostType: "html" | "js" }) =>
        context.hostType === "js" ? deps.filter((dep) => !initialChunks.has(dep)) : deps,
    },
  },
  resolve: {
    alias: {
      "@octo/ui": path.resolve(rootDir, "../../packages/ui/src"),
      "@octo/agent-client": path.resolve(rootDir, "../../packages/agent-client/src"),
    },
  },
  clearScreen: false,
  server: {
    port: uiPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
