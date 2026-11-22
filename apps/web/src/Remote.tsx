import { abortingReads, createHttpBridge, type Bridge } from "@octo/agent-client";
import { OctoApp, type HostCapabilities } from "@octo/ui";
import { useMemo, useSyncExternalStore } from "react";
import { deviceOf, WEB_PHONE_QUERY } from "./device";
import { guardedFetch } from "./guardedFetch";
import type { Me } from "./pairing";
import { pollingEventSource } from "./pollingEventSource";

/** Whether the window is phone-sized (`WEB_PHONE_QUERY`), following rotation and resizing. */
function usePhoneWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(WEB_PHONE_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WEB_PHONE_QUERY).matches,
  );
}

/**
 * The paired web client: lazily loaded so the initial pairing screen does not download `@octo/ui` or `@octo/agent-client`.
 */
export default function Remote({ token, base, me, onGone }: { token: string; base: string; me: Me; onGone(): void }) {
  const bridge = useMemo<Bridge>(() => {
    const f = guardedFetch(window.fetch.bind(window), onGone);
    // P2-4: a read never answered gives its connection back after 12 s (the long poll passes its own signal and deadline).
    return createHttpBridge({
      baseUrl: base,
      token,
      fetch: abortingReads(f.fetch),
      fetchBinary: f.fetchBinary,
      EventSource: pollingEventSource({ token, fetch: f.poll }),
    });
  }, [token, base, onGone]);
  const phone = usePhoneWindow();
  // The layout is the web host's choice (see `WEB_PHONE_QUERY`); what the device may do comes from `/pair/me`.
  const host = useMemo<HostCapabilities>(() => ({ layout: phone ? "phone" : "desktop", remoteDevice: deviceOf(me) }), [phone, me]);
  return <OctoApp bridge={bridge} bridgeUrl={base} shell="web" host={host} />;
}
