import { useEffect } from "react";
import type { BridgeEvent } from "@octo/agent-client";
import { useLatest } from "../../lib/hooks";
import { useProject } from "../../state/project";

/** Follows the open project's event stream (its one subscription; no extra connection) for as long as the host is mounted. */
export function useV7Events(handler: (event: BridgeEvent) => void): void {
  const { onEvent } = useProject();
  const latest = useLatest(handler);
  useEffect(() => onEvent((e) => latest.current(e)), [onEvent, latest]);
}
