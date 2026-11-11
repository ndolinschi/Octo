import { useMemo } from "react";
import { chooseBridge } from "./bridgeChoice";
import { BridgeShell } from "./BridgeShell";
import { HostStatus } from "./HostStatus";
import { useHostBridge } from "./hostBridge";

/** Inside Tauri: the shell starts the harness; show "Starting Octo…" / the failure until it answers. Loaded only there. */
export default function HostedApp({ search }: { search: string }) {
  const { state, retry, retrying } = useHostBridge(true);
  const hostUrl = state.phase === "ready" ? state.url : null;
  const choice = useMemo(() => chooseBridge(search, import.meta.env, hostUrl), [search, hostUrl]);
  if (state.phase !== "ready") return <HostStatus state={state} retrying={retrying} onRetry={retry} />;
  return <BridgeShell choice={choice} />;
}
