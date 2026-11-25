import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errorMessage";
import { parseConnection } from "./hostConnection";
import { parseNotices, type HostNotice } from "./hostNotices";

/** Where the Tauri shell's harness is: still starting, up at `url` (with any notices, e.g. the router did not start), or failed with its message and log tail. */
export type HostState =
  { phase: "starting" } | { phase: "ready"; url: string; token: string; notices: HostNotice[] } | { phase: "failed"; message: string; log: string };

const LOG_LINES = 20;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Loaded on demand: a browser start (and the initial bundle) never pulls the Tauri API in.
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Notices are a courtesy: a shell without the command, or a failing call, means none. */
async function notices(): Promise<HostNotice[]> {
  try {
    return parseNotices(await invoke<unknown>("bridge_notices"));
  } catch {
    return [];
  }
}

async function failure(e: unknown): Promise<HostState> {
  let log = "";
  try {
    log = await invoke<string>("bridge_log_tail", { lines: LOG_LINES });
  } catch {
    // The log is a courtesy; the message is what matters.
  }
  return { phase: "failed", message: errorMessage(e), log };
}

/**
 * Asks the Tauri shell for the harness URL and API token (`bridge_url` starts the harness on first use), and restarts it on retry
 * (`bridge_restart`). Disabled (`enabled` false) it stays in `starting` and calls nothing.
 */
export function useHostBridge(enabled: boolean): { state: HostState; retry: () => void; retrying: boolean; attempt: number } {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; state: HostState } | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const run = { live: true };
    inFlightRef.current = true;
    void (async () => {
      let next: HostState;
      try {
        const { url, token } = parseConnection(await invoke<unknown>(attempt === 0 ? "bridge_url" : "bridge_restart"));
        next = { phase: "ready", url, token, notices: await notices() };
      } catch (e) {
        next = await failure(e);
      }
      if (run.live) {
        inFlightRef.current = false;
        setResult({ attempt, state: next });
      }
    })();
    return () => {
      run.live = false;
      inFlightRef.current = false;
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    setAttempt((n) => n + 1);
  }, [enabled]);
  // A result belongs to the attempt that produced it; a newer attempt is "starting" until it answers.
  const current = result?.attempt === attempt ? result.state : null;
  return { state: current ?? { phase: "starting" }, retry, retrying: current === null && attempt > 0, attempt };
}
