import type { RemoteAccessApi, RemoteStatus } from "@octo/agent-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";

export type RemoteLoad = { status: "unavailable" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; s: RemoteStatus };

/**
 * Remote access as the computer sees it (spec 2026-11-14 remote access, section 7): `GET /v1/remote`, read again every
 * `pollMs` while the page is visible (faster while the tunnel starts), and `run(action)` for the control calls, each of
 * which answers the whole status. The bridge's `remote` member is optional: a host or a demo without it is "unavailable".
 */
export function useRemoteAccess(pollMs: number): {
  load: RemoteLoad;
  api: RemoteAccessApi | undefined;
  busy: boolean;
  actionError: string | null;
  run(action: (api: RemoteAccessApi) => Promise<RemoteStatus>): Promise<boolean>;
  retry(): void;
} {
  const api = useApp().bridge.remote;
  const [load, setLoad] = useState<RemoteLoad>(() => (api ? { status: "loading" } : { status: "unavailable" }));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const starting = load.status === "ready" && load.s.state === "starting";

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let stopped = false;
    const read = () => {
      if (document.visibilityState === "hidden") return;
      api.status().then(
        (s) => !stopped && setLoad({ status: "ready", s }),
        (e: unknown) => !stopped && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
      );
    };
    read();
    const id = window.setInterval(read, starting ? Math.min(pollMs, 700) : pollMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [api, pollMs, attempt, starting]);

  const run = useCallback(
    async (action: (a: RemoteAccessApi) => Promise<RemoteStatus>) => {
      if (!api) return false;
      setBusy(true);
      setActionError(null);
      try {
        const s = await action(api);
        if (live.current) setLoad({ status: "ready", s });
        return true;
      } catch (e) {
        if (live.current) setActionError(errorMessage(e));
        return false;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [api],
  );
  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { load, api, busy, actionError, run, retry };
}
