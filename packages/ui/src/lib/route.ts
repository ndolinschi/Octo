import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

/**
 * What the main column shows for the route's project (P1-4: the route alone says which project is shown and sent to):
 * `show` it when the list has it; `check` (re-read the list and the project) when the list does not have it yet;
 * `missing` once the harness said 404 for it, even while a stale list still has it; never another project.
 */
export type ProjectRouteState = "home" | "loading" | "show" | "check" | "missing";

export function resolveProjectRoute(projectId: string | null, projects: readonly { id: string }[] | null, missing: ReadonlySet<string>): ProjectRouteState {
  if (projectId === null) return "home";
  if (missing.has(projectId)) return "missing";
  if (projects === null) return "loading";
  return projects.some((p) => p.id === projectId) ? "show" : "check";
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

/**
 * Decision 59: `#/settings/<section>` is the settings page. The section as written (the page falls back to its first
 * section for an unknown one); `null` for any other hash. `#/settings` alone is the first section.
 */
export function parseSettingsHash(hash: string): string | null {
  const m = /^#\/settings(?:\/([^/?#]*))?\/?$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return "";
  }
}

export function settingsHref(section: string): string {
  return `#/settings/${encodeURIComponent(section)}`;
}

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/** The settings section in the location hash, or null when the settings page is not open. */
export function useSettingsSection(): string | null {
  return useSyncExternalStore(subscribeHash, () => parseSettingsHash(window.location.hash));
}
