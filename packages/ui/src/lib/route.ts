import { useEffect, useState } from "react";

export type Route = { projectId: string | null; agentId: string | null };

export function parseHash(hash: string): Route {
  const m = /^#\/p\/([^/]+)(?:\/a\/([^/]+))?/.exec(hash);
  if (!m) return { projectId: null, agentId: null };
  return { projectId: decodeURIComponent(m[1]), agentId: m[2] ? decodeURIComponent(m[2]) : null };
}

export function hrefFor(projectId: string, agentId?: string | null): string {
  const base = `#/p/${encodeURIComponent(projectId)}`;
  return agentId ? `${base}/a/${encodeURIComponent(agentId)}` : base;
}

export function navigate(projectId: string | null, agentId?: string | null): void {
  const next = projectId ? hrefFor(projectId, agentId) : "#/";
  if (window.location.hash !== next) window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
