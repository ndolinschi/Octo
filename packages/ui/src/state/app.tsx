import { errorCode } from "../lib/format";
import { setClockOffset } from "../lib/clock";
import { isAuthRefused, retryDelay, type Bridge, type BridgeConfig, type ProjectSummary, type ShellKind } from "@octo/agent-client";
import { isUnanswered, withDeadline } from "../lib/deadline";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHost } from "./host";
import { useMediaQuery } from "../lib/hooks";
import { choiceCodec, PREFS, usePersistentState } from "../lib/storage";
import { themeCodec, type Theme, type ThemeMode, type ThemePref } from "./themePref";
import { HEALTH_POLL_ONLINE_MS, PROJECTS_POLL_BUSY_MS, PROJECTS_POLL_IDLE_MS } from "../lib/constants";
import { createRequiredContext } from "../lib/context";

export type Health = "checking" | "online" | "offline";
export type OfflineCause = "refused" | "unreadable" | "unanswered" | null;

function causeOf(e: unknown): OfflineCause {
  if (isAuthRefused(e)) return "refused";
  if (errorCode(e) === "invalid_response") return "unreadable";
  return isUnanswered(e) ? "unanswered" : null;
}
export type { Theme, ThemeMode, ThemePref };

type AppValue = {
  bridge: Bridge;
  bridgeUrl: string;
  shell: ShellKind;
  demo: boolean;
  health: Health;
  /**
   * Why `health` is "offline" when it is not "nothing answered": A15 `refused` (401: it restarted with a new token), P2-4
   * `unreadable` (an answer that is not JSON) and `unanswered` (it took the connection and never answered). Null otherwise.
   */
  cause: OfflineCause;
  /**
   * P2-3: check health now. `back`: the event stream opened again, so the service is likely back. Without it (the stream
   * failed) only while online, so a stream retrying while the service is down costs nothing.
   */
  probe(back?: boolean): void;
  version: string | null;
  projects: ProjectSummary[] | null;
  config: BridgeConfig | null;
  retry(): void;
  refreshProjects(): Promise<void>;
  /** The active theme (`dark`, `cursor`, `claude`, `codex`, `opencode`, or `light`). */
  theme: Theme;
  /** What the user chose; "system" follows the OS. */
  themePref: ThemePref;
  /** False when the host dictates the theme. */
  canChooseTheme: boolean;
  setThemePref(pref: ThemePref): void;
  /** The start screens' backdrop in effect (decision 31): the choice, forced Off by reduced transparency or forced colours. */
  backdrop: Backdrop;
  backdropPref: Backdrop;
  setBackdropPref(pref: Backdrop): void;
};

/** Decision 31: Vivid (the streak), Mono (the same band in one hue), Off. */
export type Backdrop = "vivid" | "mono" | "off";
export const BACKDROPS: readonly Backdrop[] = ["vivid", "mono", "off"];
const backdropCodec = choiceCodec(BACKDROPS, "vivid");

export const { Provider: AppContextProvider, useRequired: useApp } = createRequiredContext<AppValue>("useApp");

export function AppProvider(props: { bridge: Bridge; bridgeUrl: string; shell: ShellKind; demo: boolean; children: ReactNode }) {
  const { bridge } = props;
  const [health, setHealth] = useState<Health>("checking");
  const [cause, setCause] = useState<OfflineCause>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const host = useHost();
  // Nothing is written until the user chooses: a first run leaves storage empty.
  const [themePref, setThemePref] = usePersistentState(PREFS.theme, themeCodec, { persistInitial: false });
  const systemLight = useMediaQuery("(prefers-color-scheme: light)");
  const [backdropPref, setBackdropPref] = usePersistentState(PREFS.backdrop, backdropCodec, { persistInitial: false });
  const plain = useMediaQuery("(prefers-reduced-transparency: reduce), (forced-colors: active)");
  const backdrop: Backdrop = plain ? "off" : backdropPref;
  const theme: Theme = host.theme ?? (themePref === "system" ? (systemLight ? "light" : "dark") : themePref);
  const [attempt, setAttempt] = useState(0);
  const healthRef = useRef<Health>("checking");

  useLayoutEffect(() => {
    // Swap without every colour transition firing at once.
    const root = document.documentElement;
    root.dataset.themeSwitching = "";
    root.dataset.theme = theme;
    void root.offsetHeight;
    const id = requestAnimationFrame(() => delete root.dataset.themeSwitching);
    return () => cancelAnimationFrame(id);
  }, [theme]);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await withDeadline(bridge.listProjects()));
    } catch (e) {
      // Health polling reports connectivity; a refused token or an unreadable list only shows here (`/health` needs no token).
      // P2-4: the health loop then checks again at once and keeps retrying with backoff until the list reads.
      const why = causeOf(e);
      if (why) {
        healthRef.current = "offline";
        setCause(why);
        setHealth("offline");
        setAttempt((n) => n + 1);
      }
    }
  }, [bridge]);

  // P2-4: failed checks in a row; while offline the next check comes after 1 s, 2 s, 4 s … 30 s (the load retry's policy),
  // at once when the window gets focus or the event stream opens again (`probe(true)`).
  const failures = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let checking = false;
    const check = async () => {
      window.clearTimeout(timer);
      checking = true;
      try {
        // Every read has a deadline: one that is never answered must not hold the first load ("Connecting…") for good.
        const h = await withDeadline(bridge.health());
        if (cancelled) return;
        setClockOffset(bridge.clockOffset?.() ?? 0);
        setVersion(h.version);
        if (healthRef.current !== "online") {
          const [list, cfg] = await withDeadline(Promise.all([bridge.listProjects(), bridge.getConfig()]));
          if (cancelled) return;
          setProjects(list);
          setConfig(cfg);
        }
        failures.current = 0;
        healthRef.current = "online";
        setCause(null);
        setHealth("online");
      } catch (e) {
        if (cancelled) return;
        failures.current += 1;
        setCause(causeOf(e));
        healthRef.current = "offline";
        setHealth("offline");
      }
      checking = false;
      timer = window.setTimeout(check, healthRef.current === "online" ? HEALTH_POLL_ONLINE_MS : retryDelay(failures.current));
    };
    const onFocus = () => {
      if (healthRef.current === "offline" && !checking) void check();
    };
    void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, attempt]);

  const probe = useCallback((back?: boolean) => {
    if (back ? healthRef.current === "offline" : healthRef.current === "online") setAttempt((n) => n + 1);
  }, []);

  const anyRunning = projects?.some((p) => p.status === "running") ?? false;
  useEffect(() => {
    if (health !== "online") return;
    const id = window.setInterval(() => void refreshProjects(), anyRunning ? PROJECTS_POLL_BUSY_MS : PROJECTS_POLL_IDLE_MS);
    return () => window.clearInterval(id);
  }, [health, anyRunning, refreshProjects]);

  const value = useMemo<AppValue>(
    () => ({
      bridge,
      bridgeUrl: props.bridgeUrl,
      shell: props.shell,
      demo: props.demo,
      health,
      cause,
      probe,
      version,
      projects,
      config,
      retry: () => {
        healthRef.current = "checking";
        setHealth("checking");
        setAttempt((n) => n + 1);
      },
      refreshProjects,
      theme,
      themePref,
      canChooseTheme: !host.theme,
      setThemePref: (pref) => setThemePref(pref),
      backdrop,
      backdropPref,
      setBackdropPref: (pref) => setBackdropPref(pref),
    }),
    [
      bridge,
      props.bridgeUrl,
      props.shell,
      props.demo,
      health,
      cause,
      version,
      projects,
      config,
      refreshProjects,
      probe,
      theme,
      themePref,
      setThemePref,
      host.theme,
      backdrop,
      backdropPref,
      setBackdropPref,
    ],
  );

  return <AppContextProvider value={value}>{props.children}</AppContextProvider>;
}
