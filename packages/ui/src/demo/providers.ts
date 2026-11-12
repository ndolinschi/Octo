import {
  BridgeError,
  type Bridge,
  type Models,
  type Diagnostics,
  type Provider,
  type ProviderModel,
  type ProviderPrefs,
  type ProvidersResponse,
  type Setting,
  type SettingsUpdate,
  type SettingsView,
} from "@octo/agent-client";
import { ownerProviders } from "./providersOwner";

/**
 * Demo providers, settings and diagnostics (decisions 53, 59; R1.5). Default: Claude Code ready, GitHub Copilot not
 * logged in, Grok not installed, no API key, no router. `?providers=none` (or `none: true`): Claude Code is not
 * logged in either, so Home shows the connect screen; entering any API key connects the API. `?providers=owner` is the
 * owner's live set of twelve (`providersOwner.ts`). "Check again" on a logged-out agent keeps it logged out, unless
 * `?recheck=ok` (the user has logged in since); "Use anyway" (`force_unverified`) works either way.
 */
export type DemoProvidersOptions = { none?: boolean };

const knob = (name: string): string | null => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name));

/** `?refresh=fail` makes "Refresh models" report that the agent did not start; `?refresh=none` makes it find nothing. */
function refreshFails(): boolean {
  return knob("refresh") === "fail";
}
const refreshFindsNothing = () => knob("refresh") === "none";

const CLAUDE_LOGIN = "Log in once: run `claude` and type /login (or run `claude auth login`).";
const CLAUDE_INSTALL = "Install Node.js and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code`";
const COPILOT_LOGIN =
  'Log in once: run `copilot` and type /login, or start the harness with COPILOT_GITHUB_TOKEN set to a fine-grained token that has the "Copilot Requests" permission.';
const COPILOT_INSTALL = "Install the GitHub Copilot CLI: `npm install -g @github/copilot` (needs Node.js 22 or newer and a Copilot plan)";
const GROK_LOGIN = "Log in once in the browser: run `grok login`. An XAI_API_KEY in the harness environment switches Grok to per-token billing.";
const GROK_INSTALL = "Install the Grok CLI so that `grok` is on PATH (from x.ai).";

/** The harness's catalogue (`internal/providers`): the three compiled-in tiers, deepest first. */
const API_MODELS: ProviderModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", source: "catalogue" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", source: "catalogue" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", source: "catalogue" },
];
/** An agent's models carry their id as the label (the harness has no better name); one was not advertised last time. */
const manifest = (id: string): ProviderModel => ({ id, label: id, source: "manifest" });
/** What a refresh finds for Codex, which starts with no known model (the empty second level of the picker). */
const CODEX_FOUND: ProviderModel[] = [
  { id: "gpt-5-codex", label: "gpt-5-codex", source: "advertised" },
  { id: "gpt-5.1", label: "gpt-5.1", source: "advertised" },
];
/** What a refresh finds for Claude Code when `?claude=empty` starts it with no models (the aliases its docs name). */
const CLAUDE_ALIASES: ProviderModel[] = [
  { id: "opus", label: "opus", source: "manifest" },
  { id: "sonnet", label: "sonnet", source: "manifest" },
  { id: "haiku", label: "haiku", source: "manifest" },
];
const CLAUDE_NOTE = "Claude Code does not list its models; the aliases come from its documentation.";
const SEEN_AT = "2026-11-11T12:00:00Z";

const settingDefs: Omit<Setting, "source" | "editable">[] = [
  { id: "ANTHROPIC_API_KEY", kind: "secret", label: "Anthropic API key", group: "keys", applies: "restart" },
  { id: "OCTO_ROUTER_UPSTREAM_KEY", kind: "secret", label: "Router upstream key (for example OpenRouter)", group: "router", applies: "restart" },
  {
    id: "HARNESS_MODEL_ORCHESTRATOR",
    kind: "model",
    label: "Default orchestrator",
    group: "models",
    applies: "now",
    hint: "A model id or acp:<agent-id>[/<model>]. Used by projects created from now on.",
  },
  { id: "HARNESS_MODEL_FAST", kind: "model", label: "Fast tier model", group: "models", applies: "now" },
  { id: "HARNESS_MODEL_BALANCED", kind: "model", label: "Balanced tier model", group: "models", applies: "now" },
  { id: "HARNESS_MODEL_DEEP", kind: "model", label: "Deep tier model", group: "models", applies: "now" },
  {
    id: "OCTO_ROUTER_ENABLED",
    kind: "bool",
    label: "Use the Octo router",
    group: "router",
    applies: "restart",
    hint: "Read by the desktop app, which starts the router; the harness only stores it.",
  },
  {
    id: "OCTO_ROUTER_BASE_URL",
    kind: "text",
    label: "External router URL",
    group: "router",
    applies: "restart",
    hint: "Leave empty to use the router bundled with the app.",
  },
  {
    id: "HARNESS_CHILD_ENV_ALLOW",
    kind: "list",
    label: "Environment variables passed to agents and tools",
    group: "advanced",
    applies: "now",
    hint: "Names or PREFIX_* patterns, on top of the built-in allow-list. Secrets of the harness itself are never passed.",
  },
  {
    id: "HARNESS_ACP_TRACE",
    kind: "bool",
    label: "Record an ACP wire trace",
    group: "advanced",
    applies: "now",
    hint: "One file per agent session under the data folder's traces directory, secrets removed, size-capped.",
  },
];

const BUILTIN: Record<string, string> = {
  HARNESS_MODEL_ORCHESTRATOR: "claude-sonnet-5-5",
  HARNESS_MODEL_FAST: "claude-haiku-5-5",
  HARNESS_MODEL_BALANCED: "claude-sonnet-5-5",
  HARNESS_MODEL_DEEP: "claude-opus-5-5",
};

function noneFromUrl(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("providers") === "none";
}

const delay = () => new Promise((r) => setTimeout(r, 120));

export function demoProviders(options: DemoProvidersOptions = {}): Required<
  Pick<
    Bridge,
    | "listProviders"
    | "refreshProviderModels"
    | "recheckProvider"
    | "setProviderCustomModels"
    | "setProviderPrefs"
    | "getSettings"
    | "putSettings"
    | "getDiagnostics"
  >
> & {
  /** The 422 `model_unavailable` a create or patch gets for a model whose agent cannot run (`can_force` for a login only). */
  refuse(models: Partial<Models> | undefined, force: boolean | undefined): void;
} {
  const none = options.none ?? noneFromUrl();
  // The file: id → value. Secrets are kept only to know they are set; they are never returned.
  const file = new Map<string, string | boolean | string[]>([["HARNESS_ACP_TRACE", false]]);
  const restart = new Set<string>();
  /** Per agent: names typed by the user (`custom-models`), and whether a refresh has found its models. */
  const custom = new Map<string, string[]>();
  const refreshed = new Set<string>();
  /** Agents that passed a "Check again" (their login probe now says yes). */
  const loggedIn = new Set<string>();
  const failed = new Map<string, string>();
  /** Per agent: preferred model and role models saved through `setProviderPrefs`. */
  const prefs = new Map<string, ProviderPrefs>();
  const claudeEmpty = knob("claude") === "empty";
  const owner = knob("providers") === "owner";
  const trace = (event: string, detail: unknown) => console.debug(`[octo demo] ${event}`, JSON.stringify(detail));

  const view = (): SettingsView => ({
    restart_required: [...restart],
    settings: settingDefs.map((d): Setting => {
      const v = file.get(d.id);
      const builtin = BUILTIN[d.id];
      const base: Setting = { ...d, source: v === undefined ? "default" : "file", editable: true };
      if (d.kind === "secret") return { ...base, set: v !== undefined, ...(typeof v === "string" && v.length > 8 ? { hint: `…${v.slice(-4)}` } : {}) };
      if (v !== undefined) return { ...base, value: v, set: true };
      if (builtin) return { ...base, value: builtin };
      if (d.kind === "bool") return { ...base, value: false };
      return base;
    }),
  });

  const providers = (): ProvidersResponse => {
    const apiReady = file.has("ANTHROPIC_API_KEY");
    // The router is listed only while one is detected; the demo never has one.
    const list: Provider[] = owner
      ? ownerProviders(apiReady)
      : [
          {
            id: "api",
            kind: "api",
            label: "Anthropic API",
            state: apiReady ? "ready" : "not_connected",
            reason: apiReady ? "" : "No API key",
            install_hint: "",
            login_hint: "Add an API key in Settings (ANTHROPIC_API_KEY).",
            models: API_MODELS,
            default_model: "claude-sonnet-5-5",
            flat_rate: false,
          },
          {
            id: "claude-code",
            kind: "agent",
            label: "Claude Code",
            state: none ? "not_logged_in" : "ready",
            reason: none ? "not logged in" : "",
            install_hint: CLAUDE_INSTALL,
            login_hint: CLAUDE_LOGIN,
            models: claudeEmpty
              ? []
              : [
                  manifest("claude-sonnet-5-5"),
                  manifest("claude-opus-5-5"),
                  manifest("claude-haiku-5-5"),
                  { id: "claude-opus-4-1", label: "claude-opus-4-1", source: "advertised", seen_at: SEEN_AT, stale: true },
                ],
            default_model: claudeEmpty ? "" : "claude-sonnet-5-5",
            flat_rate: true,
          },
          {
            // Ready, but it lists no model (the harness found none): the picker's second level is Default + "Other model…".
            id: "codex",
            kind: "agent",
            label: "Codex",
            state: none ? "not_logged_in" : "ready",
            reason: none ? "not logged in" : "",
            install_hint: "Install the Codex CLI: `npm install -g @openai/codex`",
            login_hint: "Log in once: run `codex login`.",
            models: [],
            default_model: "",
            flat_rate: true,
          },
          {
            id: "copilot",
            kind: "agent",
            label: "GitHub Copilot",
            state: loggedIn.has("copilot") ? "ready" : "not_logged_in",
            reason: loggedIn.has("copilot") ? "" : "not logged in",
            install_hint: COPILOT_INSTALL,
            login_hint: COPILOT_LOGIN,
            models: [manifest("gpt-5"), manifest("claude-sonnet-5-5")],
            default_model: "gpt-5",
            flat_rate: true,
          },
          {
            id: "grok",
            kind: "agent",
            label: "Grok",
            state: "not_installed",
            reason: "Grok is not installed.",
            problem: { message: "Grok is not installed.", hint: "Install it, then check again.", details: "grok: command not found on PATH" },
            install_hint: GROK_INSTALL,
            login_hint: GROK_LOGIN,
            models: [],
            default_model: "",
            flat_rate: true,
          },
        ];
    const withCustom = (p: Provider): Provider => {
      const found =
        !refreshed.has(p.id) || refreshFindsNothing() ? [] : p.id === "codex" ? CODEX_FOUND : p.id === "claude-code" && claudeEmpty ? CLAUDE_ALIASES : [];
      const saved = prefs.get(p.id);
      const typed = (custom.get(p.id) ?? []).map((id): ProviderModel => ({ id, label: id, source: "custom" }));
      const error = failed.get(p.id);
      return {
        ...p,
        models: [...p.models, ...found, ...typed.filter((t) => ![...p.models, ...found].some((m) => m.id === t.id))],
        ...(p.kind === "agent"
          ? {
              accepts_custom_model: true,
              login: p.id === "codex" ? ("unchecked" as const) : p.state === "ready" ? ("ok" as const) : ("not_logged_in" as const),
              preferred_model: saved?.preferred_model ?? "",
              roles: { fast: "", balanced: "", deep: "", ...saved?.roles },
              ...(p.id === "claude-code" ? { models_note: CLAUDE_NOTE } : {}),
              ...(refreshed.has(p.id) || (p.id === "claude-code" && !claudeEmpty) || (owner && p.models.length > 0) ? { models_refreshed_at: SEEN_AT } : {}),
            }
          : {}),
        ...(error ? { models_error: error, models_problem: { message: error, hint: "Check again in a moment.", action: "recheck_provider" as const } } : {}),
      };
    };
    const connected = list.filter((p) => p.state === "ready").length;
    const agent = !apiReady && !none ? "acp:claude-code" : null;
    const m = (id: string) => agent ?? (typeof file.get(id) === "string" ? String(file.get(id)) : (BUILTIN[id] ?? ""));
    return {
      connected,
      suggested: {
        orchestrator: m("HARNESS_MODEL_ORCHESTRATOR"),
        fast: m("HARNESS_MODEL_FAST"),
        balanced: m("HARNESS_MODEL_BALANCED"),
        deep: m("HARNESS_MODEL_DEEP"),
      },
      providers: list.map(withCustom),
    };
  };

  return {
    listProviders: async () => (await delay(), providers()),
    refreshProviderModels: async (id) => {
      await new Promise((r) => setTimeout(r, 700));
      const p = providers().providers.find((x) => x.id === id);
      if (!p) throw new BridgeError(404, "not_found", `no provider ${id}`);
      if (refreshFails()) failed.set(id, `${p.label} did not start.`);
      else {
        failed.delete(id);
        refreshed.add(id);
      }
      return providers().providers.find((x) => x.id === id) ?? null;
    },
    recheckProvider: async (id) => {
      await new Promise((r) => setTimeout(r, 700));
      const p = providers().providers.find((x) => x.id === id);
      if (!p || p.kind !== "agent") throw new BridgeError(404, "not_found", "no such agent");
      if (p.state === "not_logged_in" && knob("recheck") === "ok") loggedIn.add(id);
      trace("recheck", { id });
      return providers().providers.find((x) => x.id === id) ?? null;
    },
    refuse: (models, force) => {
      for (const value of Object.values(models ?? {})) {
        if (typeof value !== "string" || !value.startsWith("acp:")) continue;
        const p = providers().providers.find((x) => x.id === value.slice(4).split("/")[0]);
        if (!p || p.state === "ready") continue;
        const canForce = p.state === "not_logged_in";
        if (canForce && force) continue;
        const reason = `${p.label} is ${canForce ? "not logged in" : "not installed"}. ${canForce ? p.login_hint : p.install_hint}`;
        throw new BridgeError(422, "model_unavailable", `models cannot run: ${reason}`, { provider: p.id, reason, can_force: canForce });
      }
    },
    setProviderPrefs: async (id, change) => {
      await delay();
      if (!providers().providers.some((x) => x.id === id && x.kind === "agent")) throw new BridgeError(404, "not_found", `no agent ${id}`);
      const before = prefs.get(id);
      prefs.set(id, {
        ...(change.preferred_model !== undefined || before?.preferred_model !== undefined
          ? { preferred_model: change.preferred_model ?? before?.preferred_model ?? "" }
          : {}),
        roles: { ...before?.roles, ...change.roles },
      });
      trace("prefs", { id, change });
      return providers().providers.find((x) => x.id === id) ?? null;
    },
    setProviderCustomModels: async (id, models) => {
      await delay();
      if (!providers().providers.some((x) => x.id === id && x.kind === "agent")) throw new BridgeError(404, "not_found", `no agent ${id}`);
      custom.set(id, models);
      trace("custom-models", { id, models });
      return providers().providers.find((x) => x.id === id) ?? null;
    },
    getSettings: async () => (await delay(), view()),
    putSettings: async (update: SettingsUpdate) => {
      await delay();
      for (const [id, value] of Object.entries(update.set ?? {})) {
        const def = settingDefs.find((d) => d.id === id);
        if (!def) throw new BridgeError(400, "unknown_setting", `unknown setting ${id}`);
        if (def.kind === "text" && typeof value === "string" && value && !/^https?:\/\/\S+$/.test(value))
          throw new BridgeError(400, "invalid_setting", `${def.label}: not a URL (http://host:port)`);
      }
      for (const [id, value] of Object.entries(update.set ?? {})) {
        const def = settingDefs.find((d) => d.id === id);
        if ((value === "" || (Array.isArray(value) && value.length === 0)) && def?.kind !== "bool") file.delete(id);
        else file.set(id, value);
        if (def?.applies === "restart") restart.add(id);
      }
      for (const id of update.unset ?? []) {
        file.delete(id);
        if (settingDefs.find((d) => d.id === id)?.applies === "restart") restart.add(id);
      }
      // Names only, never values (a secret must not reach a log).
      trace("settings", { set: Object.keys(update.set ?? {}), unset: update.unset ?? [] });
      return view();
    },
    getDiagnostics: async (): Promise<Diagnostics> => {
      await delay();
      const p = providers();
      return {
        generated_at: new Date().toISOString(),
        version: "demo",
        go_version: "go1.26.0",
        os: "darwin",
        arch: "arm64",
        data_dir: "~/Library/Application Support/Octo/harness",
        path_for_children: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        env_set: [...file.keys()].filter((k) => k !== "HARNESS_ACP_TRACE"),
        builtin_loop: file.has("ANTHROPIC_API_KEY") ? { available: true } : { available: false, reason: "No API key and no router" },
        router: { base_url: "", detected: false, capabilities: [] },
        agents: p.providers
          .filter((x) => x.kind === "agent")
          .map((a) => ({
            id: a.id,
            label: a.label,
            available: a.state !== "not_installed",
            command: a.state === "not_installed" ? "not found" : `/opt/homebrew/bin/${a.id === "claude-code" ? "claude" : a.id}`,
            ...(a.state === "not_installed" && a.reason ? { unavailable_reason: a.reason } : {}),
            requires: [],
            probe: { ran: a.state !== "not_installed", logged_in: a.state === "not_installed" ? null : a.state === "ready", reason: a.reason },
            ...(a.login_hint ? { login_hint: a.login_hint } : {}),
            ...(a.install_hint ? { install_hint: a.install_hint } : {}),
            flat_rate: a.flat_rate,
          })),
        acp_trace: { enabled: file.get("HARNESS_ACP_TRACE") === true, dir: "~/Library/Application Support/Octo/harness/traces", files: [] },
        log_tail: ['level=INFO msg="harness serve" addr=127.0.0.1:8790', 'level=INFO msg="plugins loaded" agents=3'],
        problems: p.connected === 0 ? ["No provider is connected: log in an agent or set an API key."] : [],
      };
    },
  };
}
