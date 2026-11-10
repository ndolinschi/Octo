import type { Bridge, BridgeConfig, ProjectSummary, ShellKind } from "@octo/agent-client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHost } from "./host";
import { useMediaQuery } from "../lib/hooks";
import { readPref, writePref } from "../lib/storage";

export type Health = "checking" | "online" | "offline";
export type Theme = "dark" | "light";
export type ThemePref = "system" | Theme;

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

const AppContext = createContext<AppValue | null>(null);

function savedThemePref(): ThemePref {
  const saved = readPref("theme");
  return saved === "dark" || saved === "light" ? saved : "system";
}

export function AppProvider(props: { bridge: Bridge; bridgeUrl: string; shell: ShellKind; demo: boolean; children: ReactNode }) {
  const { bridge } = props;
  const [health, setHealth] = useState<Health>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const host = useHost();
  const [themePref, setThemePrefState] = useState<ThemePref>(savedThemePref);
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
      timer = window.setTimeout(check, healthRef.current === "online" ? 15_000 : 5_000);
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
    const id = window.setInterval(() => void refreshProjects(), anyRunning ? 3_000 : 12_000);
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
      setThemePref: (pref) => {
        setThemePrefState(pref);
        writePref("theme", pref);
      },
    }),
    [bridge, props.bridgeUrl, props.shell, props.demo, health, version, projects, config, refreshProjects, theme, themePref, host.theme],
  );

  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}
