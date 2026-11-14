import { abortingReads, createHttpBridge, type Bridge } from "@octo/agent-client";
import { OctoApp, type HostCapabilities } from "@octo/ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { deviceChanged, deviceOf, WEB_PHONE_QUERY } from "./device";
import { guardedFetch } from "./guardedFetch";
import {
  NOTICE_DENIED,
  NOTICE_DISCONNECTED,
  PairingError,
  clearToken,
  codeFromHash,
  isDeviceGone,
  saveToken,
  startPhase,
  whoAmI,
  type FetchFn,
  type Me,
  type Phase,
  type StorageLike,
} from "./pairing";
import { PairingScreen } from "./PairingScreen";
import { pollingEventSource } from "./pollingEventSource";

/** How often a waiting phone asks whether the computer allowed it, and how often a paired one checks it still is. */
const WAIT_POLL_MS = 2000;
const CHECK_MS = 30_000;

function storage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked: the token lives for this page only
  }
}

/** The code a QR link carried, read once and then removed from the address bar (it must not stay in history). */
function takeHashCode(): string | null {
  const code = codeFromHash(window.location.hash);
  if (code) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return code;
}

const pageFetch: FetchFn = (url, init) => window.fetch(url, init);

/**
 * The phone's client: the pairing screen until the computer allows this device, then the shared UI on a bridge to the
 * same origin (the harness's tunnel listener) with the device token, long-poll events and a fetch that notices a revoke.
 */
export default function App() {
  const base = window.location.origin;
  const [hashCode] = useState(takeHashCode);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [fatal, setFatal] = useState<string | null>(null);

  const gone = useCallback((notice: string) => {
    clearToken(storage());
    setPhase({ kind: "pair", code: "", notice });
  }, []);

  useEffect(() => {
    let live = true;
    startPhase(pageFetch, base, storage(), hashCode).then(
      (p) => live && setPhase(p),
      (e: unknown) => live && setFatal(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [base, hashCode]);

  // Waiting for "Allow" on the computer; ready: a quiet check that the device is still paired.
  const token = phase.kind === "waiting" || phase.kind === "ready" ? phase.token : null;
  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!token) return;
    const id = window.setInterval(
      () => {
        whoAmI(pageFetch, base, token).then(
          (me) => {
            if (waiting && me.status === "active") setPhase({ kind: "ready", token, me });
            // The computer switched this device to read-only (or back): the UI follows without a reload.
            else if (!waiting && me.status === "active") setPhase((p) => (p.kind === "ready" && deviceChanged(p.me, me) ? { ...p, me } : p));
          },
          (e: unknown) => {
            if (e instanceof PairingError && isDeviceGone(e.status, e.code)) gone(waiting ? NOTICE_DENIED : NOTICE_DISCONNECTED);
          },
        );
      },
      waiting ? WAIT_POLL_MS : CHECK_MS,
    );
    return () => window.clearInterval(id);
  }, [base, token, waiting, gone]);

  const lost = useCallback(() => gone(NOTICE_DISCONNECTED), [gone]);
  const onPaired = useCallback((t: string, name: string) => {
    saveToken(storage(), t);
    setPhase({ kind: "waiting", token: t, name });
  }, []);

  if (fatal) return <PairingScreen base={base} phase={{ kind: "pair", code: hashCode ?? "", notice: fatal }} onPaired={onPaired} />;
  if (phase.kind === "ready") return <Remote token={phase.token} base={base} me={phase.me} onGone={lost} />;
  return <PairingScreen key={phase.kind} base={base} phase={phase} onPaired={onPaired} />;
}

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

function Remote({ token, base, me, onGone }: { token: string; base: string; me: Me; onGone(): void }) {
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
