import type { Bridge } from "@octo/agent-client";
import { useMemo } from "react";
import { PREFS, usePersistentState } from "../storage";
import { hiddenModelsCodec, pickerView, type PickerOptions, type PickerView } from "./modelList";
import { useProviders, type ProvidersLoad } from "./useProviders";

/** Values left out of pickers (Settings → Models), persisted. */
export function useHiddenModels() {
  return usePersistentState(PREFS.hiddenModels, hiddenModelsCodec, { persistInitial: false });
}

/**
 * The data a model picker renders (decision 58): the provider list, the rows for `query` / the open agent, and the
 * hidden models applied. The component keeps `query`, `agent` and the active index; `pickerKey` maps its keys.
 */
export function useModelPicker(
  bridge: Bridge,
  opts: Omit<PickerOptions, "hidden"> = {},
): { load: ProvidersLoad; view: PickerView | null; refresh(): Promise<void> } {
  const providers = useProviders(bridge);
  const [hiddenList] = useHiddenModels();
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const list = providers.status === "ready" ? providers.list : providers.status === "error" ? providers.list : null;
  const { query, agent } = opts;
  const view = useMemo(
    () => (list ? pickerView(list, { hidden, ...(query !== undefined ? { query } : {}), ...(agent !== undefined ? { agent } : {}) }) : null),
    [list, hidden, query, agent],
  );
  return { load: providers, view, refresh: providers.refresh };
}
