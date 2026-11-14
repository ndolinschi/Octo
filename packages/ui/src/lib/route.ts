import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLatest } from "./hooks";

/** `sessionId` (parallel sessions, decision 96): `#/p/<pid>/s/<sid>` opens that main session; absent: the project's own. */
export type Route = { projectId: string | null; agentId: string | null; sessionId: string | null };

const NO_ROUTE: Route = { projectId: null, agentId: null, sessionId: null };

/** The route of a location hash; anything that is not a project route (including a malformed percent escape) is no route. */
export function parseHash(hash: string): Route {
  const [, projectId, kind, id] = /^#\/p\/([^/]+)(?:\/([as])\/([^/]+))?/.exec(hash) ?? [];
  if (projectId === undefined) return NO_ROUTE;
  try {
    const decoded = id ? decodeURIComponent(id) : null;
    return { projectId: decodeURIComponent(projectId), agentId: kind === "a" ? decoded : null, sessionId: kind === "s" ? decoded : null };
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

/**
 * What the conversation shows for the route's session (parallel sessions): the project's own (`default`: no session in
 * the route), `loading` until the project's sessions are read, `show`, or `missing` once the read list lacks it (deleted,
 * perhaps in another window: the tab says so instead of showing another session).
 */
export type SessionRouteState = "default" | "loading" | "show" | "missing";

export function resolveSessionRoute(sessionId: string | null, sessions: readonly { id: string }[] | null): SessionRouteState {
  if (sessionId === null) return "default";
  if (sessions === null) return "loading";
  return sessions.some((s) => s.id === sessionId) ? "show" : "missing";
}

export function hrefFor(projectId: string, agentId?: string | null, sessionId?: string | null): string {
  const base = `#/p/${encodeURIComponent(projectId)}`;
  if (agentId) return `${base}/a/${encodeURIComponent(agentId)}`;
  return sessionId ? `${base}/s/${encodeURIComponent(sessionId)}` : base;
}

export function navigate(projectId: string | null, agentId?: string | null, sessionId?: string | null): void {
  const next = projectId ? hrefFor(projectId, agentId, sessionId) : "#/";
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
