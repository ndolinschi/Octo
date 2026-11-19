import type { BranchesResult } from "@octo/agent-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

/** The last answer per project and workspace, so a remounted chip shows its branch at once (decision 98). */
const lastSeen = new Map<string, BranchesResult>();

/**
 * The composer's branch chip data (decision 98): the checked-out branch of each repository of `workspaceId`. Read on mount,
 * when the window regains focus or becomes visible, after any turn of the project ends, and when the caller asks
 * (`refresh`, the picker opening) — never on a timer. `result` is null until the first answer and when the bridge has no
 * branch route or the read failed (the chip is then not shown, as for a folder outside git).
 */
export function useBranchHead(projectId: string, workspaceId: string, enabled: boolean) {
  const { bridge } = useApp();
  const { onEvent } = useProject();
  const key = `${projectId}/${workspaceId}`;
  const [result, setResult] = useState<BranchesResult | null>(() => lastSeen.get(key) ?? null);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setResult(lastSeen.get(key) ?? null);
  }
  const seq = useRef(0);
  const list = bridge.listBranches;

  const refresh = useCallback(() => {
    if (!enabled || !list) return;
    const n = ++seq.current;
    list
      .call(bridge, projectId, { workspace: workspaceId, limit: 1 })
      .then((r) => {
        if (n !== seq.current) return;
        lastSeen.set(key, r);
        setResult(r);
      })
      .catch(() => {
        // No chip: an older harness without the route, or the folder went away. The picker shows a failure when opened.
        if (n !== seq.current) return;
        lastSeen.delete(key);
        setResult(null);
      });
  }, [bridge, list, projectId, workspaceId, key, enabled]);

  const latest = useLatest(refresh);
  useEffect(() => {
    latest.current();
    const onFocus = () => latest.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const off = onEvent((e) => {
      if (e.type === "turn.finished") latest.current();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      off();
    };
  }, [key, enabled, onEvent, latest]);

  const set = useCallback(
    (r: BranchesResult) => {
      lastSeen.set(key, r);
      setResult(r);
    },
    [key],
  );
  return { result: enabled && list ? result : null, refresh, set };
}
