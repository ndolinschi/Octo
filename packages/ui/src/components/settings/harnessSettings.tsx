import type { Setting, SettingsUpdate, SettingsView } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRequiredContext } from "../../lib/context";
import { errorMessage } from "../../lib/format";
import { refreshProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";

export type HarnessLoad = { status: "loading" } | { status: "unavailable" } | { status: "error"; message: string } | { status: "ready"; view: SettingsView };

type HarnessSettings = {
  load: HarnessLoad;
  get(id: string): Setting | undefined;
  /** Saved, but applies only after the harness (and the app's sidecars) restart. */
  needsRestart(id: string): boolean;
  /** Writes the update; the new view replaces the old one. Throws with the harness's message on refusal. */
  save(update: SettingsUpdate): Promise<void>;
  reload(): void;
};

const { Provider, useRequired } = createRequiredContext<HarnessSettings>("useHarnessSettings");
export const useHarnessSettings = useRequired;

/** The harness's settings (`harness.env`, `GET/PUT /v1/settings`), loaded once for the whole settings page. */
export function HarnessSettingsProvider({ children }: { children: ReactNode }) {
  const { bridge, health } = useApp();
  // Remote access: the settings are local only (the tunnel refuses `/v1/settings`), so a paired device does not ask.
  const local = useHost().remoteDevice === undefined;
  const [load, setLoad] = useState<HarnessLoad>(() => (bridge.getSettings && local ? { status: "loading" } : { status: "unavailable" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!bridge.getSettings || !local || health !== "online") return;
    let live = true;
    bridge.getSettings().then(
      (view) => live && setLoad({ status: "ready", view }),
      (e: unknown) => live && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      live = false;
    };
  }, [bridge, local, health, attempt]);

  const save = useCallback(
    async (update: SettingsUpdate) => {
      if (!bridge.putSettings) throw new Error("This connection cannot change the settings of Octo's local service");
      const view = await bridge.putSettings(update);
      setLoad({ status: "ready", view });
      // Keys, the router switch and default models change what can run: the pickers re-read the providers.
      void refreshProviders(bridge);
    },
    [bridge],
  );
  const reload = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<HarnessSettings>(() => {
    const view = load.status === "ready" ? load.view : null;
    return {
      load,
      get: (id) => view?.settings.find((s) => s.id === id),
      needsRestart: (id) => view?.restart_required.includes(id) ?? false,
      save,
      reload,
    };
  }, [load, save, reload]);
  return <Provider value={value}>{children}</Provider>;
}
