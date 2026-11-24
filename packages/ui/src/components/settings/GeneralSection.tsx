import { useId } from "react";
import { PREFS, sidebarViewCodec, usePersistentState, writePref } from "../../lib/storage";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Segmented";
import { Select } from "../primitives/Select";
import { Spinner } from "../primitives/Status";
import { Switch } from "../primitives/Switch";
import { ToneDot } from "../shared/providers/ProviderRows";
import { SaveStatus, SELECT_W, SettingsGroup, SettingsRow } from "./parts";
import { useSave } from "./useSave";
import { startupCodec, useMotionPref } from "./prefs";
import type { Backdrop, ThemePref } from "../../state/app";
import { THEME_CHOICES } from "../../lib/themeChoices";

export function GeneralSection() {
  const [startup, setStartup] = usePersistentState(PREFS.startup, startupCodec);
  const [saved, run] = useSave();
  const [view, setView] = usePersistentState(PREFS.sidebarView, sidebarViewCodec);
  const [savedView, runView] = useSave();
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
              onChange={(v) =>
                void run(async () => {
                  if (!writePref(PREFS.startup, startupCodec.stringify(v))) throw new Error("Could not save: the browser's storage is full or blocked");
                  setStartup(v);
                })
              }
            />
          }
        />
        <SettingsRow
          rowId="sidebar-view"
          title="Sidebar shows"
          description="How the sidebar lists your work."
          status={<SaveStatus state={savedView} />}
          control={
            <Segmented
              label="Sidebar shows"
              options={[
                { id: "tree", label: "Projects and sessions" },
                { id: "projects", label: "Projects" },
                { id: "sessions", label: "Sessions" },
              ]}
              value={view}
              onChange={(v) =>
                void runView(async () => {
                  if (!writePref(PREFS.sidebarView, sidebarViewCodec.stringify(v))) throw new Error("Could not save: the browser's storage is full or blocked");
                  setView(v);
                })
              }
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
  const state = health === "online" ? (demo ? "Demo data" : "Connected") : health === "offline" ? "Not answering" : "Connecting…";
  return (
    <SettingsRow
      rowId="bridge"
      // B8: one plain name for the background service, as the offline screen says it; the address and version in the tooltip.
      title="Octo's local service"
      description={
        <span role="status" className="inline-flex items-center gap-1.5" title={`${bridgeUrl}${version ? ` · version ${version}` : ""}`}>
          {health === "checking" ? <Spinner size="xs" /> : <ToneDot tone={health === "online" ? "ok" : "err"} />}
          {state}
          {health === "online" && !demo ? ". It keeps your projects and runs the agents." : ""}
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

const THEME_OPTIONS = THEME_CHOICES.map((t) => ({
  value: t.id,
  label: t.label,
  ...("description" in t ? { description: t.description } : {}),
}));

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
  // S2: every section confirms a change in the same place ("Saved" left of the control); these apply at once.
  const [themeSaved, saveTheme] = useSave();
  const [backdropSaved, saveBackdrop] = useSave();
  const [motionSaved, saveMotion] = useSave();
  const now = (set: () => void) => async () => {
    set();
    await Promise.resolve();
  };
  return (
    <SettingsGroup label="Look">
      <SettingsRow
        rowId="theme"
        title="Theme"
        description={canChooseTheme ? "System follows your operating system's appearance." : "Set by the app that hosts this window."}
        status={<SaveStatus state={themeSaved} />}
        control={
          canChooseTheme ? (
            <div className={SELECT_W}>
              <Select
                size="sm"
                label="Theme"
                value={themePref}
                options={THEME_OPTIONS}
                onChange={(v) => void saveTheme(now(() => setThemePref(v as ThemePref)))}
              />
            </div>
          ) : undefined
        }
      />
      <SettingsRow
        rowId="backdrop"
        title="Start-screen backdrop"
        description={
          forced ? "Off while your system asks for reduced transparency or high-contrast mode." : "Behind Home, an empty project and the first-run screen."
        }
        status={<SaveStatus state={backdropSaved} />}
        control={
          <Segmented
            label="Start-screen backdrop"
            options={BACKDROPS}
            value={backdropPref}
            onChange={(v) => void saveBackdrop(now(() => setBackdropPref(v)))}
          />
        }
      />
      <SettingsRow
        rowId="motion"
        title="Reduce motion"
        htmlFor={motionId}
        description="Turn off transitions and animations in this app, whatever the system says."
        status={<SaveStatus state={motionSaved} />}
        control={
          <Switch
            id={motionId}
            label="Reduce motion"
            checked={motion === "reduced"}
            onChange={(on) => void saveMotion(now(() => setMotion(on ? "reduced" : "system")))}
          />
        }
      />
    </SettingsGroup>
  );
}
