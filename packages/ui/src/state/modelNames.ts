import type { Agent } from "@octo/agent-client";
import { useCallback } from "react";
import { modelName, servedModel, servedText } from "../lib/models";
import { useAcpNames } from "./models";

/* Only lazily loaded views name models this way (agent header, delegations, details, sessions, usage): out of `models.ts`,
 * which the entry chunk carries. */

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
