import type { Bridge, BridgeConfig, ProjectSummary, ShellKind } from "@octo/agent-client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHost } from "./host";
import { useMediaQuery } from "../lib/hooks";
import { PREFS, usePersistentState } from "../lib/storage";
import { themeCodec, type Theme, type ThemePref } from "./themePref";
import { HEALTH_POLL_ONLINE_MS, HEALTH_POLL_OFFLINE_MS, PROJECTS_POLL_BUSY_MS, PROJECTS_POLL_IDLE_MS } from "../lib/constants";
import { createRequiredContext } from "../lib/context";

export type Health = "checking" | "online" | "offline";
export type { Theme, ThemePref };

type AppValue = {
  bridge: Bridge;
  bridgeUrl: string;
  shell: ShellKind;
  demo: boolean;
  health: Health;
  version: string | null;
  projects: ProjectSummary[] | null;
  config: BridgeConfig | null;
  retry(): void;
  refreshProjects(): Promise<void>;
  /** The theme in effect. */
  theme: Theme;
  /** What the user chose; "system" follows the OS. */
  themePref: ThemePref;
  /** False when the host dictates the theme. */
  canChooseTheme: boolean;
  setThemePref(pref: ThemePref): void;
};

export const { Provider: AppContextProvider, useRequired: useApp } = createRequiredContext<AppValue>("useApp");

export function AppProvider(props: { bridge: Bridge; bridgeUrl: string; shell: ShellKind; demo: boolean; children: ReactNode }) {
  const { bridge } = props;
  const [health, setHealth] = useState<Health>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const host = useHost();
  // Nothing is written until the user chooses: a first run leaves storage empty.
  const [themePref, setThemePref] = usePersistentState(PREFS.theme, themeCodec, { persistInitial: false });
  const systemLight = useMediaQuery("(prefers-color-scheme: light)");
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
      setProjects(await bridge.listProjects());
    } catch {
      /* health polling reports connectivity */
    }
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const check = async () => {
      try {
        const h = await bridge.health();
        if (cancelled) return;
        setVersion(h.version);
        if (healthRef.current !== "online") {
          const [list, cfg] = await Promise.all([bridge.listProjects(), bridge.getConfig()]);
          if (cancelled) return;
          setProjects(list);
          setConfig(cfg);
        }
        healthRef.current = "online";
        setHealth("online");
      } catch {
        if (cancelled) return;
        healthRef.current = "offline";
        setHealth("offline");
      }
      timer = window.setTimeout(check, healthRef.current === "online" ? HEALTH_POLL_ONLINE_MS : HEALTH_POLL_OFFLINE_MS);
    };
    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bridge, attempt]);

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
    }),
    [bridge, props.bridgeUrl, props.shell, props.demo, health, version, projects, config, refreshProjects, theme, themePref, setThemePref, host.theme],
  );

  return <AppContextProvider value={value}>{props.children}</AppContextProvider>;
}
