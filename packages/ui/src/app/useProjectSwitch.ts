import { useCallback, useState } from "react";
import type { Bridge } from "@octo/agent-client";
import type { Route } from "../lib/route";
import { canPaint, projectSnapshots } from "../state/projectCache";

/**
 * Decision 99: switching to another project never shows a blank or half-read screen. A project whose conversation is known
 * (`projectCache`) is shown at once, complete. One not read yet is read out of sight (`preload`, `state/projectPreload`) while
 * the screen keeps what it showed (`shown`: the previous project's conversation, or Home); the preload says when its loading
 * state is due (`onLate`, after SWITCH_HOLD_MS) and when to show the project (`onShow`, complete).
 * `enabled`: false while the route's project is not known to exist (no hold; its own states show).
 */
export function useProjectSwitch(route: Route, bridge: Bridge, enabled: boolean) {
  const [settled, setSettled] = useState(route);
  const [late, setLate] = useState<string | null>(null);
  const target = route.projectId;
  const holding = enabled && target !== null && target !== settled.projectId && !canPaint(projectSnapshots(bridge).get(target), route);
  if (!holding && settled !== route) setSettled(route);
  const onLate = useCallback(() => setLate(target), [target]);
  const onShow = useCallback(() => setSettled(route), [route]);
  return { shown: holding ? settled : route, preload: holding ? route : null, loading: holding && late === target, onLate, onShow };
}
