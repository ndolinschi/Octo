import type { BridgeConfig, Plugin, Provider, ProviderModel, ProvidersResponse, ProviderState, SETTING_IDS, SettingsView } from "@octo/agent-client";
import { displayId } from "../models";
import { isReady } from "./providers";
import { API_PROVIDER, ROUTER_PROVIDER } from "./providersMore";

/** The settings this module reads (lib sees agent-client's types only, so the ids are spelled here and type-checked). */
const API_KEY: (typeof SETTING_IDS)["anthropicApiKey"] = "ANTHROPIC_API_KEY";
const ROUTER_ENABLED: (typeof SETTING_IDS)["routerEnabled"] = "OCTO_ROUTER_ENABLED";

/** The model list of an API provider: the default models, once each, without agent values. */
function apiModels(config: BridgeConfig | null): ProviderModel[] {
  if (!config) return [];
  const m = config.default_models;
  const ids = [...new Set([m.orchestrator, m.balanced, m.fast, m.deep].filter((id) => id && !id.startsWith("acp:")))];
  return ids.map((id) => ({ id, label: displayId(id), source: "catalogue" as const }));
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
export function deriveProviders(input: { config: BridgeConfig | null; plugins: readonly Plugin[]; settings?: SettingsView | null }): ProvidersResponse {
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
        reason: state === "not_installed" ? (a.unavailable_reason ?? "not installed") : state === "not_logged_in" ? "not logged in" : "",
        install_hint: a.install_hint ?? "",
        login_hint: a.hint ?? "",
        models: ids.map((id) => ({ id, label: displayId(id), source: "manifest" as const })),
        default_model: a.default_model ?? "",
        flat_rate: a.flat_rate === true,
      });
    }
  }
  const api: Provider = {
    id: API_PROVIDER,
    kind: "api",
    label: "Anthropic API",
    state: apiReady ? "ready" : "not_connected",
    reason: apiReady ? "" : "No API key",
    install_hint: "",
    login_hint: "Add an API key in Settings (ANTHROPIC_API_KEY).",
    models: apiReady ? models : [],
    default_model: config?.default_models.balanced ?? "",
    flat_rate: false,
  };
  const router: Provider = {
    id: ROUTER_PROVIDER,
    kind: "router",
    label: "Octo router",
    state: config?.router === true ? "ready" : routerOn ? "error" : "not_connected",
    reason: config?.router !== true && routerOn ? "Switched on, but Octo's local service can't find it" : "",
    install_hint: "",
    login_hint: "",
    models: config?.router === true ? models : [],
    default_model: config?.default_models.balanced ?? "",
    flat_rate: false,
  };
  const all = [api, router, ...providers];
  return { connected: all.filter(isReady).length, suggested: suggestedFrom(all, config), providers: all };
}

/** Decision 53 c: an API provider keeps the default tiers; with only agents, the first ready agent runs everything. */
function suggestedFrom(providers: readonly Provider[], config: BridgeConfig | null): ProvidersResponse["suggested"] {
  const viaApi = providers.some((p) => p.kind !== "agent" && isReady(p));
  const agent = providers.find((p) => p.kind === "agent" && isReady(p));
  if (!viaApi && agent) {
    const v = `acp:${agent.id}`;
    return { orchestrator: v, fast: v, balanced: v, deep: v };
  }
  const m = config?.default_models;
  return { orchestrator: m?.orchestrator ?? "", fast: m?.fast ?? "", balanced: m?.balanced ?? "", deep: m?.deep ?? "" };
}
