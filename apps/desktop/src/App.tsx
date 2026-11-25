import { lazy, Suspense, useMemo } from "react";
import { chooseBridge, isTauri, usesHostBridge } from "./bridgeChoice";
import { BridgeShell } from "./BridgeShell";

// Only a Tauri window loads the host start-up code; a browser start never downloads it.
const HostedApp = lazy(() => import("./HostedApp"));

export default function App() {
  const search = window.location.search;
  const viaHost = useMemo(() => usesHostBridge(search, import.meta.env, isTauri(window)), [search]);
  const choice = useMemo(() => chooseBridge(search, import.meta.env), [search]);
  if (viaHost) {
    return (
      <Suspense fallback={null}>
        <HostedApp search={search} />
      </Suspense>
    );
  }
  return <BridgeShell choice={choice} />;
}
