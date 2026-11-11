import { resolveBridgeUrl, type EnvLike } from "@octo/agent-client";
import type { DemoLsp, DemoOptions, DemoSeed } from "@octo/ui/demo";

/** Which bridge the app talks to: the harness over HTTP, or the in-memory demo (`?demo=…`). */
export type BridgeChoice = { kind: "http"; baseUrl: string } | { kind: "demo"; options: DemoOptions };

const SEEDS: readonly DemoSeed[] = ["empty", "one", "many"];
const LSP_MODES: readonly DemoLsp[] = ["fail-once", "slow", "exit"];

/**
 * Chooses the bridge from the page's query string and the build environment. Any non-empty `demo` runs the demo
 * bridge: `?demo=empty|one|many` picks the seed (anything else is the full one), `?lsp=fail-once|slow|exit` the
 * language-server behaviour, `?plugins=none` no plugins. Otherwise the harness is reached at
 * `VITE_HARNESS_BRIDGE_URL` (default http://127.0.0.1:8790). `hostUrl` is the address the Tauri shell reports for the
 * harness it started; it wins over the default and the environment (see `usesHostBridge`).
 */
export function chooseBridge(search: string, env: EnvLike, hostUrl?: string | null): BridgeChoice {
  const params = new URLSearchParams(search);
  const demo = params.get("demo");
  if (!demo) return { kind: "http", baseUrl: hostUrl ? hostUrl.replace(/\/+$/, "") : resolveBridgeUrl(env) };
  const seed = SEEDS.find((s) => s === demo) ?? "full";
  const lsp = LSP_MODES.find((l) => l === params.get("lsp")) ?? "ok";
  return { kind: "demo", options: { seed, lsp, plugins: params.get("plugins") !== "none" } };
}

/** The `bridgeUrl` prop of `OctoApp`: the demo has no URL. */
export function bridgeLabel(choice: BridgeChoice): string {
  return choice.kind === "demo" ? "demo" : choice.baseUrl;
}

/** True inside a Tauri webview: the shell injects `__TAURI_INTERNALS__` into the window (checked on any object so tests need no DOM). */
export function isTauri(win: object | undefined): boolean {
  return win !== undefined && "__TAURI_INTERNALS__" in win;
}

/**
 * Whether the page must ask the Tauri shell for the bridge URL (and show the starting/failed screen): inside Tauri,
 * not the demo, and no explicit `VITE_HARNESS_BRIDGE_URL`. In a browser, never: today's behaviour.
 */
export function usesHostBridge(search: string, env: EnvLike, inTauri: boolean): boolean {
  if (!inTauri) return false;
  if (new URLSearchParams(search).get("demo")) return false;
  return !env.VITE_HARNESS_BRIDGE_URL;
}
