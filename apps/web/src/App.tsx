import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { deviceChanged } from "./device";
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

const Remote = lazy(() => import("./Remote"));

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
  const [checkRun, setCheckRun] = useState(0);

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
  }, [base, hashCode, checkRun]);

  // Waiting for "Allow" on the computer; ready: a quiet check that the device is still paired.
  const token = phase.kind === "waiting" || phase.kind === "ready" ? phase.token : null;
  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!token) return;
    let live = true;
    let inFlight: AbortController | null = null;
    const id = window.setInterval(
      () => {
        if (!live || document.hidden) return;
        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        whoAmI(pageFetch, base, token, controller.signal).then(
          (me) => {
            if (!live) return;
            if (waiting && me.status === "active") setPhase({ kind: "ready", token, me });
            // The computer switched this device to read-only (or back): the UI follows without a reload.
            else if (!waiting && me.status === "active") setPhase((p) => (p.kind === "ready" && deviceChanged(p.me, me) ? { ...p, me } : p));
          },
          (e: unknown) => {
            if (!live || controller.signal.aborted) return;
            if (e instanceof PairingError && isDeviceGone(e.status, e.code)) gone(waiting ? NOTICE_DENIED : NOTICE_DISCONNECTED);
          },
        );
      },
      waiting ? WAIT_POLL_MS : CHECK_MS,
    );
    return () => {
      live = false;
      window.clearInterval(id);
      inFlight?.abort();
    };
  }, [base, token, waiting, gone]);

  const lost = useCallback(() => gone(NOTICE_DISCONNECTED), [gone]);
  const onPaired = useCallback((t: string, name: string) => {
    saveToken(storage(), t);
    setFatal(null);
    setPhase({ kind: "waiting", token: t, name });
  }, []);
  const retry = useCallback(() => {
    setFatal(null);
    setPhase({ kind: "checking" });
    setCheckRun((n) => n + 1);
  }, []);

  if (fatal) return <PairingScreen base={base} phase={{ kind: "pair", code: hashCode ?? "", notice: fatal }} onPaired={onPaired} onRetry={retry} />;
  if (phase.kind === "ready") {
    return (
      <Suspense
        fallback={
          <main className="flex min-h-full items-center justify-center bg-window text-sm text-fg-2">
            <p role="status">Loading Octo…</p>
          </main>
        }
      >
        <Remote token={phase.token} base={base} me={phase.me} onGone={lost} />
      </Suspense>
    );
  }
  return <PairingScreen key={phase.kind} base={base} phase={phase} onPaired={onPaired} />;
}
