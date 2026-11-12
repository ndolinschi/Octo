import type { Provider, ProvidersResponse, ProviderState } from "@octo/agent-client";
import { agentModelLabel, displayId, modelLabel, modelName } from "../models";

/** Ids of the two providers that are not agents (`GET /v1/providers` uses the same ones). */
export const API_PROVIDER = "api";
export const ROUTER_PROVIDER = "router";

export const isReady = (p: Pick<Provider, "state">): boolean => p.state === "ready";

const STATE_TEXT: Record<ProviderState, string> = {
  ready: "Ready",
  not_connected: "Not connected",
  not_logged_in: "Not logged in",
  not_installed: "Not installed",
  error: "Not working",
};

/** The state as one or two words (rows, chips). */
export function stateText(state: ProviderState): string {
  return STATE_TEXT[state];
}

/** The harness's reason when it says more than the state does ("grok: command not found on PATH"), else "" ("not logged in" after "Not logged in"). */
export function extraReason(p: Pick<Provider, "state" | "reason">): string {
  return p.reason && p.reason.trim().toLowerCase() !== STATE_TEXT[p.state].toLowerCase() ? p.reason : "";
}

/**
 * The button a provider row shows (decision 53): Connect when it never worked, Reconnect when it did and stopped. An agent
 * that was never set up (not installed, not logged in) has nothing to press: its sheet lists the commands, so "How to connect".
 */
export function connectAction(p: Pick<Provider, "state" | "kind">): "Connect" | "Reconnect" | "How to connect" | "Manage" {
  if (p.state === "ready") return "Manage";
  if (p.state === "error") return "Reconnect";
  if (p.kind === "agent") return "How to connect";
  return "Connect";
}

/** The provider a new project would run on (the connect screen says which one, decision 53 b). */
export function providerOf(list: ProvidersResponse, value: string): Provider | undefined {
  if (value.startsWith("acp:")) {
    const id = value.slice(4).split("/")[0];
    return list.providers.find((p) => p.kind === "agent" && p.id === id);
  }
  return (
    list.providers.find((p) => p.kind !== "agent" && isReady(p) && p.models.some((m) => m.id === value)) ??
    list.providers.find((p) => p.kind !== "agent" && isReady(p))
  );
}

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
