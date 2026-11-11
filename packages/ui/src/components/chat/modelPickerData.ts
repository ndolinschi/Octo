import type { Plugin } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { buildPickerData, type PickerData } from "./modelPicker";

/**
 * The model picker's data source: the one seam to swap for the shared providers hook (`lib/providers`) when it lands.
 * Contract: `data` lists only what can run as far as the store knows (decision 53 a); `loading` is true until the
 * agent list has been read once (the picker shows a skeleton row meanwhile).
 */
export type ModelPickerSource = { data: PickerData; loading: boolean };

export function useModelPickerData(): ModelPickerSource {
  const { config } = useApp();
  const { project } = useProject();
  const activity = useActivity();
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  useEffect(() => {
    let alive = true;
    // Without the plugin list, agents come from the config alone (still runnable choices); nothing else waits on it.
    activity.plugins().then(
      (list) => alive && setPlugins(list),
      () => alive && setPlugins([]),
    );
    return () => {
      alive = false;
    };
  }, [activity]);
  const models = project?.models;
  const data = useMemo(
    () => buildPickerData({ config, plugins, project: models, builtinAvailable: config?.builtin_loop?.available !== false }),
    [config, plugins, models],
  );
  return { data, loading: plugins === null };
}
