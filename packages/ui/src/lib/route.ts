import { useEffect, useRef, useState } from "react";
import { useLatest } from "./hooks";

export type Route = { projectId: string | null; agentId: string | null };

const NO_ROUTE: Route = { projectId: null, agentId: null };

/** The route of a location hash; anything that is not a project route (including a malformed percent escape) is no route. */
export function parseHash(hash: string): Route {
  const [, projectId, agentId] = /^#\/p\/([^/]+)(?:\/a\/([^/]+))?/.exec(hash) ?? [];
  if (projectId === undefined) return NO_ROUTE;
  try {
    return { projectId: decodeURIComponent(projectId), agentId: agentId ? decodeURIComponent(agentId) : null };
  } catch {
    // A URL typed or pasted by hand: the home route is the recovery, not a crash in the first render.
    return NO_ROUTE;
  }
}

export function hrefFor(projectId: string, agentId?: string | null): string {
  const base = `#/p/${encodeURIComponent(projectId)}`;
  return agentId ? `${base}/a/${encodeURIComponent(agentId)}` : base;
}

export function navigate(projectId: string | null, agentId?: string | null): void {
  const next = projectId ? hrefFor(projectId, agentId) : "#/";
  if (window.location.hash !== next) window.location.hash = next;
}

/**
 * The current route, with a veto: when `block(next, current)` is true a hash change is undone
 * (the URL goes back to the old hash) and held as `pending` until `proceed()` or `stay()`.
 */
export function useGuardedRoute(block: (next: Route, current: Route) => boolean) {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [pending, setPending] = useState<string | null>(null);
  const current = useLatest(route);
  const blockRef = useLatest(block);
  const bypass = useRef(false);

  useEffect(() => {
    const onChange = (e: HashChangeEvent) => {
      const hash = window.location.hash;
      const next = parseHash(hash);
      if (!bypass.current && blockRef.current(next, current.current)) {
        window.history.replaceState(window.history.state, "", e.oldURL);
        setPending(hash);
        return;
      }
      bypass.current = false;
      setRoute(next);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [blockRef, current]);

  return {
    route,
    pending: pending !== null,
    proceed: () => {
      if (pending === null) return;
      bypass.current = true;
      setPending(null);
      window.location.hash = pending;
    },
    stay: () => setPending(null),
  };
}
