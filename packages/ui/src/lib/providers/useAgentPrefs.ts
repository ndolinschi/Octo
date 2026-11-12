import type { Bridge, ProviderPrefs } from "@octo/agent-client";
import { useCallback } from "react";
import { PREFS, usePersistentState } from "../storage";
import { agentPrefsCodec, withAgentPrefs, type AgentPrefsLocal } from "./modelList";
import { refreshProviders } from "./useProviders";

/**
 * An agent's preferred model and role models (decision 72 b-c): saved through `Bridge.setProviderPrefs`; a bridge without
 * it keeps them in this browser (`local`), which the model lists read as the fallback. A failed save throws, so the row
 * that asked can say so.
 */
export function useAgentPrefs(bridge: Bridge): {
  local: Readonly<Record<string, AgentPrefsLocal>>;
  save(agentId: string, change: ProviderPrefs): Promise<void>;
} {
  const [local, setLocal] = usePersistentState(PREFS.agentPrefs, agentPrefsCodec, { persistInitial: false });
  const save = useCallback(
    async (agentId: string, change: ProviderPrefs) => {
      if (bridge.setProviderPrefs) {
        await bridge.setProviderPrefs(agentId, change);
        await refreshProviders(bridge);
        return;
      }
      setLocal((all) => ({ ...all, [agentId]: withAgentPrefs(all[agentId], change) }));
    },
    [bridge, setLocal],
  );
  return { local, save };
}
