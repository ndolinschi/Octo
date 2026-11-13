import { useEffect } from "react";
import { runsReducer } from "../../lib/commands/runs";
import { useProject } from "../../state/project";
import { projectRuns, runTabStatus } from "../../lib/projectRuns";
import { useLatest } from "../../lib/hooks";
import { useRunsStore } from "../../state/projectRuns";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useCommandsApi } from "./useCommandsApi";

/**
 * Keeps the project's run store (`state/projectRuns`) current for as long as the project is open: the runs so far, once, then
 * `command.*` events folded as they arrive (no polling). Renders nothing; the top row, the run tabs and the status bar read
 * the store. A list that does not load leaves the store empty: starting a run still works and says why when it does not.
 */
export default function ProjectRunsFeed() {
  const api = useCommandsApi();
  const store = useRunsStore();
  const { onEvent } = useProject();
  const ws = useWorkspace();
  const wsRef = useLatest(ws);
  // The run tabs' state goes to the workspace (which draws the tabs) whenever it changes, not on every output chunk.
  useEffect(() => {
    let last = "";
    const sync = () => {
      const s = store.get();
      const statuses: Record<string, "running" | "failed"> = {};
      for (const r of projectRuns(s)) {
        const name = r.name.toLowerCase();
        const status = runTabStatus(s, name);
        if (status) statuses[name] = status;
      }
      const key = JSON.stringify(statuses);
      if (key === last) return;
      last = key;
      wsRef.current.setRunStatuses(statuses);
    };
    sync();
    return store.subscribe(sync);
  }, [store, wsRef]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.list().then(
      (runs) => alive && store.update((s) => runsReducer(s, { type: "loaded", runs })),
      () => undefined, // earlier runs are missing from the Run tabs; a new run still appears
    );
    return () => {
      alive = false;
    };
  }, [api, store]);
  useEffect(() => onEvent((event) => store.update((s) => runsReducer(s, { type: "event", event }))), [onEvent, store]);
  return null;
}
