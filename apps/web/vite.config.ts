import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
// @ts-expect-error node globals are not typed in this project
const port = Number(process.env.OCTO_WEB_PORT) || 1430;

/**
 * The Content-Security-Policy the harness sends with this app's pages (apps/harness/internal/remoteaccess/static.go,
 * `CSP`; the harness test `TestWebBuildCSPIsTheHeader` keeps the two equal), also written into the built page as a <meta>, so the files keep it when
 * something else serves them. `frame-ancestors` works only as a header, so the <meta> leaves it out. Not in development:
 * Vite's dev page runs an inline script.
 */
const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'none'; object-src 'none'";

const cspMeta: Plugin = {
  name: "octo:csp-meta",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: WEB_CSP.replace(/frame-ancestors [^;]*; /, "") },
      injectTo: "head-prepend",
    },
  ],
};

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

/**
 * The phone's client (spec 2026-11-14-remote-access-mobile-design.md): `@octo/ui` built as static files that the harness
 * serves at the tunnel root (`HARNESS_REMOTE_WEB_DIR=apps/web/dist`). Same-origin with the API, so no bridge URL is baked in.
 * In development the harness proxies to this server (`HARNESS_REMOTE_WEB_PROXY=http://127.0.0.1:1430`).
 */
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), cspMeta, collectInitialChunks],
  build: {
    rolldownOptions: {
      output: {
        // Everything the page loads at start (the entry and its static imports, `$initial`) in ONE chunk so gzip compresses
        // a single stream instead of dozens of tiny preloaded chunks. Lazy chunks (`Remote`, Monaco, etc.) import from it.
        codeSplitting: { groups: [{ name: "index", tags: ["$initial" as const] }] },
      },
    },
    modulePreload: {
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
  server: { port, strictPort: true, host: "127.0.0.1" },
  preview: { port, strictPort: true, host: "127.0.0.1" },
}));
