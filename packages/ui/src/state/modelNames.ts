import type { Agent } from "@octo/agent-client";
import { useCallback, useMemo } from "react";
import { modelName, servedModel, servedText } from "../lib/models";
import { useProviders, withProviderLabels } from "../lib/providers";
import { useApp } from "./app";
import { useAcpNames } from "./models";

/* Only lazily loaded views name models this way (agent header, delegations, details, sessions, usage): out of `models.ts`,
 * which the entry chunk carries. */

/**
 * Model names as shown (decision 37, ACP in the UI): `name(value)` for a setting, `served(agent)` for the model that
 * answered an agent — short (the served name alone) and long ("deepseek-v4.1-flash · asked for Sonnet 5.5").
 */
export function useModelNames() {
  const { bridge } = useApp();
  const configured = useAcpNames();
  const providers = useProviders(bridge);
  // The provider list names the accounts of an agent ("Claude Code · Work"); the config only knows the agents.
  const agents = providers.status === "loading" ? null : providers.list?.providers;
  const acp = useMemo(() => (agents ? withProviderLabels(configured, agents) : configured), [configured, agents]);
  const name = useCallback((value: string) => modelName(value, acp), [acp]);
  const served = useCallback((agent: Pick<Agent, "model" | "served_model">) => ({ ...servedModel(agent, acp), long: servedText(agent, acp) }), [acp]);
  return { name, served };
}
