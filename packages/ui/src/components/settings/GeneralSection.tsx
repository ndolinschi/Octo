import { useId } from "react";
import { PREFS, usePersistentState } from "../../lib/storage";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Segmented";
import { Spinner } from "../primitives/Status";
import { SaveStatus, SettingsGroup, SettingsRow, StateDot, Switch } from "./parts";
import { useSave } from "./useSave";
import { startupCodec, useMotionPref } from "./prefs";
import type { Backdrop, ThemePref } from "../../state/app";

export function GeneralSection() {
  const [startup, setStartup] = usePersistentState(PREFS.startup, startupCodec);
  const [saved, run] = useSave();
  return (
    <>
      <SettingsGroup label="Startup">
        <SettingsRow
          rowId="startup"
          title="On startup"
          description="Open the project you used last, or start on Home."
          status={<SaveStatus state={saved} />}
          control={
            <Segmented
              label="On startup"
              options={[
                { id: "last", label: "Last project" },
                { id: "home", label: "Home" },
              ]}
              value={startup}
              onChange={(v) => void run(async () => setStartup(v))}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup label="Connection">
        <BridgeRow />
      </SettingsGroup>
    </>
  );
}

function BridgeRow() {
  const { bridgeUrl, health, retry, version, demo } = useApp();
  const state =
    health === "online"
      ? demo
        ? "Demo data, in memory"
        : `Connected${version ? `, version ${version}` : ""}`
      : health === "offline"
        ? "Offline: the harness does not answer"
        : "Connecting…";
  return (
    <SettingsRow
      rowId="bridge"
      title="Harness connection"
      leading={health === "checking" ? <Spinner size={10} /> : <StateDot tone={health === "online" ? "ok" : "err"} />}
      description={
        <span className="flex min-w-0 flex-wrap gap-x-2">
          <code className="min-w-0 font-mono text-xs break-all text-fg-2">{bridgeUrl}</code>
          <span role="status">{state}</span>
        </span>
      }
      control={
        health === "offline" ? (
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}

const THEMES = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const satisfies readonly { id: ThemePref; label: string }[];

const BACKDROPS = [
  { id: "vivid", label: "Vivid" },
  { id: "mono", label: "Mono" },
  { id: "off", label: "Off" },
] as const satisfies readonly { id: Backdrop; label: string }[];

export function AppearanceSection() {
  const { canChooseTheme, themePref, setThemePref, backdropPref, setBackdropPref, backdrop } = useApp();
  const forced = backdrop === "off" && backdropPref !== "off";
  const [motion, setMotion] = useMotionPref();
  const motionId = useId();
  return (
    <SettingsGroup label="Look">
      <SettingsRow
        rowId="theme"
        title="Theme"
        description={canChooseTheme ? "System follows your operating system's appearance." : "Set by the app that hosts this window."}
        control={canChooseTheme ? <Segmented label="Theme" options={THEMES} value={themePref} onChange={setThemePref} /> : undefined}
      />
      <SettingsRow
        rowId="backdrop"
        title="Start-screen backdrop"
        description={
          forced ? "Off while your system asks for reduced transparency or forced colours." : "Behind Home, an empty project and the first-run screen."
        }
        control={<Segmented label="Start-screen backdrop" options={BACKDROPS} value={backdropPref} onChange={setBackdropPref} />}
      />
      <SettingsRow
        rowId="motion"
        title="Reduce motion"
        htmlFor={motionId}
        description="Turn off transitions and animations in this app, whatever the system says."
        control={<Switch id={motionId} label="Reduce motion" checked={motion === "reduced"} onChange={(on) => setMotion(on ? "reduced" : "system")} />}
      />
    </SettingsGroup>
  );
}
