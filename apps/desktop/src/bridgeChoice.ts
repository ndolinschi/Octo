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
 * `VITE_HARNESS_BRIDGE_URL` (default http://127.0.0.1:8790).
 */
export function chooseBridge(search: string, env: EnvLike): BridgeChoice {
  const params = new URLSearchParams(search);
  const demo = params.get("demo");
  if (!demo) return { kind: "http", baseUrl: resolveBridgeUrl(env) };
  const seed = SEEDS.find((s) => s === demo) ?? "full";
  const lsp = LSP_MODES.find((l) => l === params.get("lsp")) ?? "ok";
  return { kind: "demo", options: { seed, lsp, plugins: params.get("plugins") !== "none" } };
}

/** The `bridgeUrl` prop of `OctoApp`: the demo has no URL. */
export function bridgeLabel(choice: BridgeChoice): string {
  return choice.kind === "demo" ? "demo" : choice.baseUrl;
}
