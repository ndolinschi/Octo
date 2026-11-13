import type { Provider, ProvidersResponse } from "@octo/agent-client";
import { agentModelLabel, displayId, modelLabel, modelName } from "../models";

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
      return `${agent.label} · ${known ? agentModelLabel(known) : displayId(model)}`;
    }
    return modelName(value, agents);
  }
  for (const p of list.providers) {
    const m = p.models.find((x) => x.id === value);
    if (m) return modelLabel(m);
  }
  return displayId(value);
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
