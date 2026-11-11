import { createHttpBridge, type Bridge } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import type { BridgeChoice } from "./bridgeChoice";

/**
 * The bridge for a choice. The HTTP bridge exists on the first render; the demo bridge (and its fixtures) loads from
 * `@octo/ui/demo` with `import()`, so a normal start never downloads it, and the hook returns null until it is in.
 */
export function useBridge(choice: BridgeChoice): Bridge | null {
  const http = useMemo(() => (choice.kind === "http" ? createHttpBridge({ baseUrl: choice.baseUrl }) : null), [choice]);
  const [demo, setDemo] = useState<Bridge | null>(null);
  useEffect(() => {
    if (choice.kind !== "demo") return;
    let live = true;
    void Promise.all([import("@octo/ui/demo"), import("./demo")]).then(([m, extras]) => {
      if (live) setDemo(extras.withDemoExtras(m.createDemoBridge(choice.options), window.location.search));
    });
    return () => {
      live = false;
    };
  }, [choice]);
  return choice.kind === "http" ? http : demo;
}
