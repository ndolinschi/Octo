import type { Agent } from "@octo/agent-client";
import { useCallback } from "react";
import { modelName, servedModel, servedText, type AcpName } from "../lib/models";
import { useApp } from "./app";

const NONE: readonly AcpName[] = [];

/** The ACP agents the bridge offers (their labels name `acp:` settings). */
export function useAcpNames(): readonly AcpName[] {
  return useApp().config?.acp_orchestrators ?? NONE;
}

/**
 * Model names as shown (decision 37, ACP in the UI): `name(value)` for a setting, `served(agent)` for the model that
 * answered an agent — short (the served name alone) and long ("deepseek-v4.1-flash · asked for Sonnet 5.5").
 */
export function useModelNames() {
  const acp = useAcpNames();
  const name = useCallback((value: string) => modelName(value, acp), [acp]);
  const served = useCallback((agent: Pick<Agent, "model" | "served_model">) => ({ ...servedModel(agent, acp), long: servedText(agent, acp) }), [acp]);
  return { name, served };
}
