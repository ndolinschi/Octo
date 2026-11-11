import { useMemo, useState } from "react";
import { chooseBridge } from "./bridgeChoice";
import { BridgeShell } from "./BridgeShell";
import { HostNotice } from "./HostNotice";
import { HostStatus } from "./HostStatus";
import { useHostBridge } from "./hostBridge";

/**
 * Inside Tauri: the shell starts the harness (and the router when it is switched on); show "Starting Octo…" / the
 * failure until the harness answers, then the app, with a one-line notice when the router could not start. Loaded only
 * inside Tauri.
 */
export default function HostedApp({ search }: { search: string }) {
  const { state, retry, retrying } = useHostBridge(true);
  // A dismissal belongs to the url it was made on: a restart starts a new run with new notices.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const hostUrl = state.phase === "ready" ? state.url : null;
  const choice = useMemo(() => chooseBridge(search, import.meta.env, hostUrl), [search, hostUrl]);
  if (state.phase !== "ready") return <HostStatus state={state} retrying={retrying} onRetry={retry} />;
  const notice = dismissedFor === state.url ? undefined : state.notices[0];
  return (
    <>
      <BridgeShell choice={choice} />
      {notice ? <HostNotice notice={notice} retrying={retrying} onRetry={retry} onDismiss={() => setDismissedFor(state.url)} /> : null}
    </>
  );
}
