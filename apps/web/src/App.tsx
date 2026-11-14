import { createHttpBridge, type Bridge } from "@octo/agent-client";
import { OctoApp } from "@octo/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  if (phase.kind === "ready") return <Remote token={phase.token} base={base} onGone={lost} />;
  return <PairingScreen key={phase.kind} base={base} phase={phase} onPaired={onPaired} />;
}

function Remote({ token, base, onGone }: { token: string; base: string; onGone(): void }) {
  const bridge = useMemo<Bridge>(() => {
    const f = guardedFetch(window.fetch.bind(window), onGone);
    return createHttpBridge({ baseUrl: base, token, fetch: f.fetch, fetchBinary: f.fetchBinary, EventSource: pollingEventSource({ token, fetch: f.poll }) });
  }, [token, base, onGone]);
  return <OctoApp bridge={bridge} bridgeUrl={base} shell="web" />;
}
