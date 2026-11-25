import type { Provider, ProvidersResponse } from "@octo/agent-client";
import { agentModelLabel, displayId, modelLabel, modelName, parseAcp, readableModelId, tidyAgentLabel } from "../models";

export const isReady = (p: Pick<Provider, "state">): boolean => p.state === "ready";

/** Decision 58: a model setting as a chip reads it — "Claude Code · Opus 5.5", a model's label, else the id shortened. */
export function chipLabel(value: string, list: ProvidersResponse | null): string {
  if (!list) return modelName(value);
  const agents = list.providers.filter((p) => p.kind === "agent");
  const ref = parseAcp(value);
  if (ref) {
    const agent = agents.find((p) => p.id === ref.id);
    if (agent && ref.model) {
      const known = agent.models.find((m) => m.id === ref.model);
      return `${agent.label} · ${known ? agentModelLabel(known) : tidyAgentLabel(readableModelId(ref.model))}`;
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
  if (value === "small" || value.startsWith("ollama:")) {
    const ollama = list.providers.find((p) => p.kind === "ollama");
    return ollama ? isReady(ollama) : true;
  }
  const ref = parseAcp(value);
  if (ref) {
    const agent = list.providers.find((p) => p.kind === "agent" && p.id === ref.id);
    if (!agent || !isReady(agent)) return false;
    return !ref.model || agent.models.length === 0 || agent.models.some((m) => m.id === ref.model);
  }
  // An API key or the router runs any model id (and the tiers); the harness says so when one does not exist.
  return list.providers.some((p) => (p.kind === "api" || p.kind === "router") && isReady(p));
}
