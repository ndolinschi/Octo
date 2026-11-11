import type { BridgeConfig, Plugin, Provider, ProviderList, ProviderModel, ProviderState, SETTING_IDS, SettingsView } from "@octo/agent-client";
import { displayId, modelName } from "../models";

/** Ids of the two providers that are not agents (`GET /v1/providers` uses the same ones). */
export const API_PROVIDER = "anthropic-api";
export const ROUTER_PROVIDER = "octo-router";

/** The settings this module reads (lib sees agent-client's types only, so the ids are spelled here and type-checked). */
const API_KEY: (typeof SETTING_IDS)["anthropicApiKey"] = "ANTHROPIC_API_KEY";
const ROUTER_ENABLED: (typeof SETTING_IDS)["routerEnabled"] = "OCTO_ROUTER_ENABLED";

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

/** The model list of an API provider: the default models, once each, without agent values. */
function apiModels(config: BridgeConfig | null): ProviderModel[] {
  if (!config) return [];
  const m = config.default_models;
  const ids = [...new Set([m.orchestrator, m.balanced, m.fast, m.deep].filter((id) => id && !id.startsWith("acp:")))];
  return ids.map((id) => ({ id, label: displayId(id) }));
}

function secretSet(settings: SettingsView | null | undefined, id: string): boolean | null {
  const s = settings?.settings.find((x) => x.id === id);
  return s ? s.set === true : null;
}

function boolSetting(settings: SettingsView | null | undefined, id: string): boolean | null {
  const s = settings?.settings.find((x) => x.id === id);
  return s && typeof s.value === "boolean" ? s.value : null;
}

/**
 * The provider list built from what an older harness offers (config, plugins, settings), for a harness that predates
 * `GET /v1/providers`. Unknown is read as connected, so a missing field never locks anyone out (decision 53 b).
 */
export function deriveProviders(input: { config: BridgeConfig | null; plugins: readonly Plugin[]; settings?: SettingsView | null }): ProviderList {
  const { config, plugins, settings } = input;
  const builtin = config?.builtin_loop?.available ?? true;
  const routerOn = config?.router === true || boolSetting(settings, ROUTER_ENABLED) === true;
  const keySet = secretSet(settings, API_KEY);
  const apiReady = keySet ?? (builtin && !routerOn);
  const models = apiModels(config);
  const providers: Provider[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    for (const a of plugin.agents) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const choice = config?.acp_orchestrators?.find((c) => c.id === a.id);
      const ids = [...new Set([...(a.default_model ? [a.default_model] : []), ...(a.models ?? []), ...(choice?.models ?? [])])];
      const state: ProviderState = !a.available ? "not_installed" : a.logged_in === false ? "not_logged_in" : "ready";
      providers.push({
        id: a.id,
        kind: "agent",
        label: a.label,
        state,
        ...(state === "not_installed" && a.unavailable_reason ? { reason: a.unavailable_reason } : {}),
        ...(a.install_hint ? { install_hint: a.install_hint } : {}),
        ...(a.hint ? { login_hint: a.hint } : {}),
        models: ids.map((id) => ({ id, label: displayId(id) })),
        ...(a.default_model ? { default_model: a.default_model } : {}),
      });
    }
  }
  const api: Provider = {
    id: API_PROVIDER,
    kind: "api",
    label: "Anthropic API",
    state: apiReady ? "ready" : "not_connected",
    ...(apiReady ? {} : { reason: "No API key" }),
    models: apiReady ? models : [],
  };
  const router: Provider = {
    id: ROUTER_PROVIDER,
    kind: "router",
    label: "Octo router",
    state: config?.router === true ? "ready" : routerOn ? "error" : "not_connected",
    ...(config?.router !== true && routerOn ? { reason: "Switched on, but the harness does not see it" } : {}),
    models: config?.router === true ? models : [],
  };
  const all = [api, router, ...providers];
  return { connected: all.filter(isReady).length, suggested: suggestedFrom(all, config), providers: all };
}

/** Decision 53 c: an API provider keeps the default tiers; with only agents, the first ready agent runs everything. */
function suggestedFrom(providers: readonly Provider[], config: BridgeConfig | null): ProviderList["suggested"] {
  const viaApi = providers.some((p) => p.kind !== "agent" && isReady(p));
  const agent = providers.find((p) => p.kind === "agent" && isReady(p));
  if (!viaApi && agent) {
    const v = `acp:${agent.id}`;
    return { orchestrator: v, fast: v, balanced: v, deep: v };
  }
  const m = config?.default_models;
  return { orchestrator: m?.orchestrator ?? "", fast: m?.fast ?? "", balanced: m?.balanced ?? "", deep: m?.deep ?? "" };
}

/** The provider a new project would run on (the connect screen says which one, decision 53 b). */
export function providerOf(list: ProviderList, value: string): Provider | undefined {
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
export function chipLabel(value: string, list: ProviderList | null): string {
  if (!list) return modelName(value);
  const agents = list.providers.filter((p) => p.kind === "agent");
  if (value.startsWith("acp:")) {
    const [id, model] = value.slice(4).split("/", 2);
    const agent = agents.find((p) => p.id === id);
    if (agent && model) return `${agent.label} · ${agent.models.find((m) => m.id === model)?.label ?? displayId(model)}`;
    return modelName(value, agents);
  }
  for (const p of list.providers) {
    const m = p.models.find((x) => x.id === value);
    if (m) return m.label;
  }
  return displayId(value);
}

/** Whether a model setting can run now (decision 53 a): its provider is ready and still lists it. */
export function canRun(list: ProviderList, value: string): boolean {
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
