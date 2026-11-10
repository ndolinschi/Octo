import { createHttpBridge, resolveBridgeUrl } from "@octo/agent-client";
import { createDemoBridge, OctoApp, type DemoLsp } from "@octo/ui";
import { useMemo } from "react";

export default function App() {
  const bridgeUrl = resolveBridgeUrl(import.meta.env);
  const params = new URLSearchParams(window.location.search);
  const demo = params.get("demo");
  // Demo knobs: ?lsp=fail-once|slow|exit (language server behaviour), ?plugins=none (no plugins).
  const lsp = params.get("lsp");
  const plugins = params.get("plugins") !== "none";
  const bridge = useMemo(
    () =>
      demo
        ? createDemoBridge({
            seed: demo === "empty" || demo === "one" || demo === "many" ? demo : "full",
            lsp: lsp === "fail-once" || lsp === "slow" || lsp === "exit" ? (lsp as DemoLsp) : "ok",
            plugins,
          })
        : createHttpBridge({ baseUrl: bridgeUrl }),
    [demo, bridgeUrl, lsp, plugins],
  );
  return <OctoApp bridge={bridge} bridgeUrl={demo ? "demo" : bridgeUrl} shell="desktop" demo={Boolean(demo)} />;
}
