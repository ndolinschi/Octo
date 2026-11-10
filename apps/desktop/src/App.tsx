import { createHttpBridge, resolveBridgeUrl } from "@octo/agent-client";
import { createDemoBridge, OctoApp } from "@octo/ui";
import { useMemo } from "react";

export default function App() {
  const bridgeUrl = resolveBridgeUrl(import.meta.env);
  const demo = new URLSearchParams(window.location.search).get("demo");
  const bridge = useMemo(
    () =>
      demo
        ? createDemoBridge({ seed: demo === "empty" || demo === "one" || demo === "many" ? demo : "full" })
        : createHttpBridge({ baseUrl: bridgeUrl }),
    [demo, bridgeUrl],
  );
  return <OctoApp bridge={bridge} bridgeUrl={demo ? "demo" : bridgeUrl} shell="desktop" demo={Boolean(demo)} />;
}
