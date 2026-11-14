import type { Bridge, ProviderList } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { withDeadline } from "../deadline";
import { errorMessage } from "../format";

export type ProvidersLoad =
  { status: "loading" } | { status: "ready"; list: ProviderList; refreshing: boolean } | { status: "error"; message: string; list: ProviderList | null };

type Entry = { load: ProvidersLoad; listeners: Set<() => void>; inflight: Promise<void> | null };

/** One cache per bridge: every picker, the settings page and the connect screen read the same list. */
const cache = new WeakMap<Bridge, Entry>();

function entry(bridge: Bridge): Entry {
  let e = cache.get(bridge);
  if (!e) {
    e = { load: { status: "loading" }, listeners: new Set(), inflight: null };
    cache.set(bridge, e);
  }
  return e;
}

function set(e: Entry, load: ProvidersLoad): void {
  e.load = load;
  for (const l of e.listeners) l();
}

const isNotFound = (e: unknown) => typeof e === "object" && e !== null && "status" in e && e.status === 404;

/** `GET /v1/providers`, or the list derived from config + plugins (+ settings) on a harness that predates it. */
export async function fetchProviders(bridge: Bridge): Promise<ProviderList> {
  if (bridge.listProviders) {
    try {
      return await bridge.listProviders();
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  const [config, plugins, settings] = await Promise.all([
    bridge.getConfig(),
    bridge.listPlugins(),
    // Settings answer 403 off loopback; the list is then derived without them (unknown reads as connected).
    bridge.getSettings ? bridge.getSettings().catch(() => null) : Promise.resolve(null),
  ]);
  // Only for a harness that predates /v1/providers: loaded on demand, so the app shell's chunk stays small.
  const { deriveProviders } = await import("./derive");
  return deriveProviders({ config, plugins, settings });
}

/** The list as last loaded (null before the first answer or after a first failure). */
export function providersSnapshot(bridge: Bridge): ProviderList | null {
  const { load } = entry(bridge);
  return load.status === "loading" ? null : load.list;
}

/** Loads (or reloads) the provider list of `bridge`; concurrent calls share one request. */
export function refreshProviders(bridge: Bridge): Promise<void> {
  const e = entry(bridge);
  if (e.inflight) return e.inflight;
  const prev = e.load;
  if (prev.status === "ready") set(e, { ...prev, refreshing: true });
  // P2-4: a read never answered ends as a failure after its deadline, so "Check again" (which joins the read in flight) can run.
  e.inflight = withDeadline(fetchProviders(bridge))
    .then(
      (list) => set(e, { status: "ready", list, refreshing: false }),
      (err: unknown) => set(e, { status: "error", message: errorMessage(err), list: prev.status === "ready" ? prev.list : null }),
    )
    .finally(() => {
      e.inflight = null;
    });
  return e.inflight;
}

/** The provider list of `bridge` (loaded on first use, shared), and `refresh` for "Check again" and after a change. */
export function useProviders(bridge: Bridge, enabled = true): ProvidersLoad & { refresh(): Promise<void> } {
  const subscribe = useCallback(
    (l: () => void) => {
      const en = entry(bridge);
      en.listeners.add(l);
      return () => en.listeners.delete(l);
    },
    [bridge],
  );
  const load = useSyncExternalStore(subscribe, () => entry(bridge).load);
  useEffect(() => {
    // A list that failed is read again when the bridge comes back (`enabled` turns true again after an offline spell).
    const { status } = entry(bridge).load;
    if (enabled && (status === "loading" || status === "error") && !entry(bridge).inflight) void refreshProviders(bridge);
  }, [bridge, enabled]);
  const refresh = useCallback(() => refreshProviders(bridge), [bridge]);
  return useMemo(() => ({ ...load, refresh }), [load, refresh]);
}
