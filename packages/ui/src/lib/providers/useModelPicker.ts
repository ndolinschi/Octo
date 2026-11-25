import type { Bridge } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../format";
import { PREFS, usePersistentState } from "../storage";
import {
  agentPrefsCodec,
  cleanModelName,
  customModelsCodec,
  hiddenModelsCodec,
  needsModelRefresh,
  pickerView,
  withCustomModel,
  withoutCustomModel,
  type PickerOptions,
  type PickerView,
} from "./modelList";
import { useProviders, type ProvidersLoad } from "./useProviders";

/** Values left out of pickers (Settings → Models), persisted. */
export function useHiddenModels() {
  return usePersistentState(PREFS.hiddenModels, hiddenModelsCodec, { persistInitial: false });
}

/** Agents whose models were asked for by opening the picker, per bridge: once each for the life of the app, so it never loops. */
const autoAsked = new WeakMap<Bridge, Set<string>>();

/** True the first time it is called for this agent and bridge. */
function firstAsk(bridge: Bridge, agentId: string): boolean {
  let set = autoAsked.get(bridge);
  if (!set) autoAsked.set(bridge, (set = new Set()));
  if (set.has(agentId)) return false;
  set.add(agentId);
  return true;
}

export type ModelPickerData = {
  load: ProvidersLoad;
  view: PickerView | null;
  refresh(): Promise<void>;
  /** "Refresh models" of one agent: null when it worked, else what to say (the bridge cannot, the agent did not start). */
  refreshModels(agentId: string): Promise<string | null>;
  /** Remembers a model name for an agent (here, and in the harness when it can store it). */
  addModel(agentId: string, name: string): void;
  /** Forgets a name that was typed. */
  removeModel(agentId: string, name: string): void;
  /** True while "Refresh models" runs. */
  refreshing: boolean;
};

/**
 * The data a model picker renders (decision 58): the provider list, the rows for `query` / the open agent, the hidden
 * models applied, and the names typed for agents (kept in this browser, and sent to the harness when it has the
 * endpoint). The component keeps `query`, `agent` and the active index; `pickerKey` maps its keys.
 */
export function useModelPicker(bridge: Bridge, opts: Omit<PickerOptions, "hidden" | "custom"> = {}): ModelPickerData {
  const providers = useProviders(bridge);
  const [hiddenList] = useHiddenModels();
  const [custom, setCustom] = usePersistentState(PREFS.customModels, customModelsCodec, { persistInitial: false });
  const [localPrefs] = usePersistentState(PREFS.agentPrefs, agentPrefsCodec, { persistInitial: false });
  const [refreshing, setRefreshing] = useState(false);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const list = providers.status === "ready" ? providers.list : providers.status === "error" ? providers.list : null;
  const { query, agent, current } = opts;
  const view = useMemo(
    () =>
      list
        ? pickerView(list, {
            hidden,
            custom,
            localPrefs,
            ...(query !== undefined ? { query } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(current !== undefined ? { current } : {}),
          })
        : null,
    [list, hidden, custom, localPrefs, query, agent, current],
  );
  const { refresh } = providers;
  const store = useCallback(
    (agentId: string, names: string[]) => {
      // Best effort: the local copy is the one that always works (an older harness has no endpoint).
      void bridge.setProviderCustomModels?.(agentId, names).then(
        () => refresh(),
        () => undefined,
      );
    },
    [bridge, refresh],
  );
  const addModel = useCallback(
    (agentId: string, name: string) => {
      const next = withCustomModel(custom[agentId] ?? [], name);
      if (!cleanModelName(name)) return;
      setCustom({ ...custom, [agentId]: next });
      store(agentId, next);
    },
    [custom, setCustom, store],
  );
  const removeModel = useCallback(
    (agentId: string, name: string) => {
      const next = withoutCustomModel(custom[agentId] ?? [], name);
      setCustom({ ...custom, [agentId]: next });
      store(agentId, next);
    },
    [custom, setCustom, store],
  );
  const refreshModels = useCallback(
    async (agentId: string): Promise<string | null> => {
      if (!bridge.refreshProviderModels) return "Octo's local service can't list this agent's models. Update it, or use “Other model…”.";
      setRefreshing(true);
      try {
        const p = await bridge.refreshProviderModels(agentId);
        await refresh();
        return p?.models_error?.trim() ? p.models_error : null;
      } catch (e) {
        return errorMessage(e);
      } finally {
        setRefreshing(false);
      }
    },
    [bridge, refresh],
  );
  // Opening an agent whose list is empty or never read asks the harness once (decision 58); "Refresh models" asks again by hand.
  const open = view?.level === "agent" ? view.agent : null;
  const openId = open?.id;
  const stale = open ? needsModelRefresh(open) : false;
  useEffect(() => {
    // Deferred a tick: the effect starts a request, it does not set state of its own.
    if (openId && stale && firstAsk(bridge, openId)) void Promise.resolve().then(() => refreshModels(openId));
  }, [bridge, openId, stale, refreshModels]);
  return { load: providers, view, refresh, refreshModels, addModel, removeModel, refreshing };
}
