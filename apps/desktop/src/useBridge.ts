import { abortingReads, createHttpBridge, type Bridge, type FetchLike } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import type { BridgeChoice } from "./bridgeChoice";

/**
 * The bridge for a choice. The HTTP bridge exists on the first render; the demo bridge (and its fixtures) loads from
 * `@octo/ui/demo` with `import()`, so a normal start never downloads it, and the hook returns null until it is in.
 */
export function useBridge(choice: BridgeChoice): Bridge | null {
  const http = useMemo(() => {
    if (choice.kind !== "http") return null;
    const options = { baseUrl: choice.baseUrl, ...(choice.token ? { token: choice.token } : {}), fetch: readsWithTimeout };
    // Image previews in Files read bytes through `readFileBytes` (an optional method the UI looks for). Its code loads
    // with the first image, not with the app.
    const bridge = createHttpBridge(options);
    const readFileBytes = async (projectId: string, folder: string, path: string) =>
      (await import("@octo/agent-client/fileBytes")).withFileBytes(bridge, options).readFileBytes(projectId, folder, path);
    return Object.assign(bridge, { readFileBytes });
  }, [choice]);
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

/** The webview's fetch as the client's `FetchLike`; P2-4: a read never answered gives its connection back (`abortingReads`). */
const readsWithTimeout: FetchLike = abortingReads((url, init) => {
  const { signal, ...rest } = init ?? {};
  return fetch(url, signal instanceof AbortSignal ? { ...rest, signal } : rest);
});
