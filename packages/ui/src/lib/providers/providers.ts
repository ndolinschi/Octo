import type { Provider, ProvidersResponse } from "@octo/agent-client";
import { agentModelLabel, displayId, modelLabel, modelName, readableModelId, tidyAgentLabel } from "../models";

export const isReady = (p: Pick<Provider, "state">): boolean => p.state === "ready";

/** Decision 58: a model setting as a chip reads it — "Claude Code · Opus 5.5", a model's label, else the id shortened. */
export function chipLabel(value: string, list: ProvidersResponse | null): string {
  if (!list) return modelName(value);
  const agents = list.providers.filter((p) => p.kind === "agent");
  if (value.startsWith("acp:")) {
    const [id, model] = value.slice(4).split("/", 2);
    const agent = agents.find((p) => p.id === id);
    if (agent && model) {
      const known = agent.models.find((m) => m.id === model);
      return `${agent.label} · ${known ? agentModelLabel(known) : tidyAgentLabel(readableModelId(model))}`;
    }
    return modelName(value, agents);
  }
  for (const p of list.providers) {
    const m = p.models.find((x) => x.id === value);
    if (m) return modelLabel(m);
  }
  return displayId(value);
}

/**
 * Item 10: a chip label in its two parts when it names an agent's model ("Claude Code · " and "Opus 5.5"): a chip that must
 * shorten drops the provider part first (the mark beside it still says whose model it is; the tooltip keeps the full name).
 * Null for a label of one part.
 */
export function chipParts(label: string): { provider: string; model: string } | null {
  const at = label.indexOf(" · ");
  if (at <= 0) return null;
  const model = label.slice(at + 3).trim();
  return model ? { provider: label.slice(0, at + 3), model } : null;
}

/** Whether a model setting can run now (decision 53 a): its provider is ready and still lists it. */
export function canRun(list: ProvidersResponse, value: string): boolean {
  if (!value) return false;
  if (value.startsWith("acp:")) {
    const [id, model] = value.slice(4).split("/", 2);
    const agent = list.providers.find((p) => p.kind === "agent" && p.id === id);
    if (!agent || !isReady(agent)) return false;
    return !model || agent.models.length === 0 || agent.models.some((m) => m.id === model);
  }
  // An API key or the router runs any model id (and the tiers); the harness says so when one does not exist.
  return list.providers.some((p) => p.kind !== "agent" && isReady(p));
}
