import {
  BridgeError,
  type Bridge,
  type ModelIssue,
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
import { accountSlug } from "../lib/providers/accounts";

/**
 * Demo providers, settings and diagnostics (decisions 53, 59; R1.5). Default: Claude Code ready, GitHub Copilot not
 * logged in, Grok not installed, no API key, no router. `?providers=none` (or `none: true`): Claude Code is not
 * logged in either, so Home shows the connect screen; entering any API key connects the API. `?providers=owner` is the
 * owner's live set of twelve (`providersOwner.ts`). "Check again" on a logged-out agent keeps it logged out, unless
 * `?recheck=ok` (the user has logged in since). `?claude=loggedout` is Claude Code alone not logged in (the New project dialog and the
 * empty project then show the calm "log in later or choose another model" notice). A create or patch is never refused for an unready
 * agent; the project lists it in `models_unavailable`.
 */
export type DemoProvidersOptions = { none?: boolean };

const knob = (name: string): string | null => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name));

/** `?refresh=fail` makes "Refresh models" report that the agent did not start; `?refresh=none` makes it find nothing. */
function refreshFails(): boolean {
  return knob("refresh") === "fail";
}
const refreshFindsNothing = () => knob("refresh") === "none";
/** `?router=on`: a detected, switched-on Octo router (the default demo has none). */
const routerOn = () => knob("router") === "on";
const ROUTER_URL = "http://127.0.0.1:8791";
const ROUTER_PROVIDER: Provider = {
  id: "router",
  kind: "router",
  label: "Octo router",
  state: "ready",
  reason: "",
  install_hint: "",
  login_hint: "",
  models: [
    { id: "claude-haiku-5-5", label: "Haiku 5.5", source: "catalogue" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", source: "catalogue" },
    { id: "claude-opus-5-5", label: "Opus 5.5", source: "catalogue" },
  ],
  default_model: "claude-sonnet-5-5",
  flat_rate: false,
};

const CLAUDE_LOGIN = "Log in once: run `claude` and type /login (or run `claude auth login`).";
const CLAUDE_INSTALL = "Install Node.js and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code`";
const COPILOT_LOGIN =
  'Log in once: run `copilot` and type /login, or start Octo\'s local service with COPILOT_GITHUB_TOKEN set to a fine-grained token that has the "Copilot Requests" permission.';
const COPILOT_INSTALL = "Install the GitHub Copilot CLI: `npm install -g @github/copilot` (needs Node.js 22 or newer and a Copilot plan)";
const GROK_LOGIN =
  "Log in once in the browser: run `grok login`. An XAI_API_KEY in the environment of Octo's local service switches Grok to per-token billing.";
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
    id: "HARNESS_MODEL_COMPLETION",
    kind: "model",
    label: "Inline completion model (Ollama small tier)",
    group: "models",
    applies: "now",
    hint: "Ollama model tag used when inline completion runs through the dedicated small tier.",
  },
  {
    id: "HARNESS_OLLAMA_BASE_URL",
    kind: "text",
    label: "Ollama server URL",
    group: "models",
    applies: "now",
    hint: "Base URL of the Ollama server for the small inline-completion tier (default http://127.0.0.1:11434).",
  },
  {
    id: "OCTO_ROUTER_ENABLED",
    kind: "bool",
    label: "Use the Octo router",
    group: "router",
    applies: "restart",
    hint: "Read by the desktop app, which starts the router; Octo's local service only stores it.",
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
    hint: "Names or PREFIX_* patterns, on top of the built-in allow-list. Secrets of Octo's local service itself are never passed.",
  },
  {
    id: "HARNESS_ACP_TRACE",
    kind: "bool",
    label: "Record an ACP wire trace",
    group: "advanced",
    applies: "now",
    hint: "One file per agent session under the data folder's traces directory, secrets removed, size-capped.",
  },
  {
    id: "HARNESS_FEATURE_AUTO_MEMORY",
    kind: "bool",
    label: "Auto-memory prompt & digest",
    group: "advanced",
    applies: "now",
    hint: "When on, agents ask before saving memories (or save in Allow/Review mode) and update end-of-turn digests when allowed. Turn off to disable all automatic memory writes.",
  },
];

const BOOL_DEFAULTS: Record<string, boolean> = {
  HARNESS_FEATURE_AUTO_MEMORY: true,
};

const BUILTIN: Record<string, string> = {
  HARNESS_MODEL_ORCHESTRATOR: "claude-sonnet-5-5",
  HARNESS_MODEL_FAST: "claude-haiku-5-5",
  HARNESS_MODEL_BALANCED: "claude-sonnet-5-5",
  HARNESS_MODEL_DEEP: "claude-opus-5-5",
  HARNESS_MODEL_COMPLETION: "qwen2.5-coder:1.5b",
};

function noneFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  return q.get("providers") === "none" || q.get("claude") === "loggedout";
}

const delay = () => new Promise((r) => setTimeout(r, 120));

type DemoAccount = { agent: string; id: string; label: string; dir: string };

/** The login command of each demo agent that takes accounts, run with its folder (the harness's `login_hint`). */
const ACCOUNT_LOGIN: Record<string, string> = { "claude-code": "claude auth login", codex: "codex login" };

/** An account's own entry, as the harness lists it: the agent's models and billing, its own id, label, login and state. */
function accountEntry(agent: Provider, a: DemoAccount, ready: boolean): Provider {
  const id = `${agent.id}@${a.id}`;
  const login = `${agent.account_env ?? ""}=${a.dir} ${ACCOUNT_LOGIN[agent.id] ?? ""}`.trim();
  const { account_env: _env, account_default: _default, ...rest } = agent;
  return {
    ...rest,
    id,
    label: `${agent.label} · ${a.label}`,
    state: ready ? "ready" : "not_logged_in",
    reason: ready ? "" : "not logged in",
    login_hint: `Log this account in once: run \`${login}\` in a terminal. Its login stays in ${a.dir}.`,
    account_of: agent.id,
    account_id: a.id,
    account_label: a.label,
    account_dir: a.dir,
  };
}

export function demoProviders(options: DemoProvidersOptions = {}): Required<
  Pick<
    Bridge,
    | "listProviders"
    | "refreshProviderModels"
    | "recheckProvider"
    | "setProviderCustomModels"
    | "setProviderPrefs"
    | "addAgentAccount"
    | "removeAgentAccount"
    | "getSettings"
    | "putSettings"
    | "getDiagnostics"
  >
> & {
  /** The stored models that cannot run now, as a project lists them (`models_unavailable`); a create or patch is never refused for them. */
  unusable(models: Partial<Models>): ModelIssue[];
  /** Live process-wide feature flags derived from settings. */
  features(): Record<string, boolean>;
} {
  const none = options.none ?? noneFromUrl();
  // The file: id → value. Secrets are kept only to know they are set; they are never returned.
  const file = new Map<string, string | boolean | string[]>([["HARNESS_ACP_TRACE", false], ...(routerOn() ? ([["OCTO_ROUTER_ENABLED", true]] as const) : [])]);
  const restart = new Set<string>();
  /** Per agent: names typed by the user (`custom-models`), and whether a refresh has found its models. */
  const custom = new Map<string, string[]>();
  const refreshed = new Set<string>();
  /** Agents that passed a "Check again" (their login probe now says yes). */
  const loggedIn = new Set<string>();
  let ollamaStarted = false;
  const failed = new Map<string, string>();
  /** Per agent: preferred model and role models saved through `setProviderPrefs`. */
  const prefs = new Map<string, ProviderPrefs>();
  /** Agent accounts added through `addAgentAccount`; `?accounts=work` starts with a logged-in Claude Code "Work" account. */
  const accounts: DemoAccount[] = knob("accounts") === "work" ? [{ agent: "claude-code", id: "work", label: "Work", dir: "~/.claude-work" }] : [];
  if (knob("accounts") === "work") loggedIn.add("claude-code@work");
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
      if (d.kind === "bool") return { ...base, value: BOOL_DEFAULTS[d.id] ?? false };
      return base;
    }),
  });

  const providers = (): ProvidersResponse => {
    const apiReady = file.has("ANTHROPIC_API_KEY");
    // The router is listed only while one is detected (`?router=on`, below).
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
            account_env: "CLAUDE_CONFIG_DIR",
            account_default: "~/.claude",
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
            account_env: "CODEX_HOME",
            account_default: "~/.codex",
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
    // R2: `?router=on` — an Octo router is detected (and switched on in the settings), so Settings → Providers lists it and
    // its detail can be seen; with `?providers=owner` too.
    if (routerOn()) list.unshift(ROUTER_PROVIDER);
    const rawOllamaModel = file.get("HARNESS_MODEL_COMPLETION");
    const ollamaModel = typeof rawOllamaModel === "string" && rawOllamaModel !== "" ? rawOllamaModel : "qwen2.5-coder:1.5b";
    const rawOllamaUrl = file.get("HARNESS_OLLAMA_BASE_URL");
    const ollamaUrl = typeof rawOllamaUrl === "string" && rawOllamaUrl !== "" ? rawOllamaUrl : "http://127.0.0.1:11434";
    const ollamaModels: ProviderModel[] = [
      { id: "qwen2.5-coder:1.5b", label: "Qwen 2.5 Coder 1.5B", source: "catalogue" },
      { id: "qwen2.5-coder:3b", label: "Qwen 2.5 Coder 3B", source: "catalogue" },
      { id: "starcoder2:3b", label: "StarCoder2 3B", source: "catalogue" },
      { id: "codellama:7b", label: "CodeLlama 7B", source: "catalogue" },
      ...(ollamaModel !== "" && !["qwen2.5-coder:1.5b", "qwen2.5-coder:3b", "starcoder2:3b", "codellama:7b"].includes(ollamaModel)
        ? [{ id: ollamaModel, label: ollamaModel, source: "catalogue" as const }]
        : []),
    ];
    // `?ollama=down`: nothing answers at the Ollama URL (the harness's reach probe); "Check again" with `?recheck=ok` starts it.
    const ollamaDown = knob("ollama") === "down" && !ollamaStarted;
    list.splice(routerOn() ? 2 : 1, 0, {
      id: "ollama",
      kind: "ollama",
      label: "Ollama",
      state: ollamaDown ? "not_running" : "ready",
      reason: ollamaDown ? "Ollama is not running." : "",
      ...(ollamaDown
        ? {
            problem: {
              message: "Ollama is not running.",
              hint: "Start it, then check again.",
              command: "ollama serve",
              action: "recheck_provider",
              details: `Nothing answered at ${ollamaUrl}: dial tcp: connect: connection refused.`,
            },
          }
        : {}),
      reach: ollamaDown ? "not_running" : "ok",
      install_hint: "",
      login_hint: "",
      models: ollamaModels,
      default_model: ollamaModel,
      flat_rate: true,
      accepts_custom_model: true,
      models_note: `Dedicated small tier (${ollamaUrl}) for inline editor completions.`,
    });
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
    // Each account is an agent of its own, listed right after its agent (the harness's order).
    const all = list.flatMap((p) => [p, ...accounts.filter((a) => a.agent === p.id).map((a) => accountEntry(p, a, loggedIn.has(`${p.id}@${a.id}`)))]);
    list.splice(0, list.length, ...all);
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
      if (p?.kind === "ollama") {
        if (knob("recheck") === "ok") ollamaStarted = true;
        trace("recheck", { id });
        return providers().providers.find((x) => x.id === id) ?? null;
      }
      if (!p || p.kind !== "agent") throw new BridgeError(404, "not_found", "no such agent");
      if (p.state === "not_logged_in" && knob("recheck") === "ok") loggedIn.add(id);
      trace("recheck", { id });
      return providers().providers.find((x) => x.id === id) ?? null;
    },
    unusable: (models) => {
      const out: ModelIssue[] = [];
      for (const [field, value] of Object.entries(models)) {
        if (typeof value !== "string" || !value.startsWith("acp:") || field === "tier_policy") continue;
        const p = providers().providers.find((x) => x.id === value.slice(4).split("/")[0]);
        if (!p || p.state === "ready") continue;
        const loggedOut = p.state === "not_logged_in";
        out.push({ field, model: value, provider: p.id, reason: `${p.label} is ${loggedOut ? "not logged in" : "not installed"}.` });
      }
      return out;
    },
    features: () => ({
      auto_memory: file.has("HARNESS_FEATURE_AUTO_MEMORY")
        ? file.get("HARNESS_FEATURE_AUTO_MEMORY") === true
        : BOOL_DEFAULTS.HARNESS_FEATURE_AUTO_MEMORY === true,
    }),
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
    addAgentAccount: async (agentId, input) => {
      await delay();
      const agent = providers().providers.find((x) => x.id === agentId);
      if (!agent) throw new BridgeError(404, "not_found", `no agent ${agentId}`);
      if (!agent.account_env)
        throw Object.assign(new BridgeError(400, "invalid_request", `${agent.label} cannot have more than one account in Octo.`), {
          hint: "Add accounts to Claude Code or Codex instead.",
        });
      const label = input.label.trim();
      const id = input.id ?? accountSlug(label);
      const dir = input.config_dir.trim();
      if (!label) throw new BridgeError(400, "invalid_request", "An account needs a short name.");
      if (!dir.startsWith("/") && !dir.startsWith("~/"))
        throw Object.assign(new BridgeError(400, "invalid_request", "That folder cannot hold this account's login."), {
          hint: "Use a full path or one that starts with ~/, without $ signs, and not the agent's default folder.",
        });
      if (accounts.some((a) => a.agent === agentId && (a.id === id || a.dir === dir)))
        throw Object.assign(new BridgeError(409, "conflict", "This agent has an account with that name or folder already."), {
          hint: "Choose another name and another folder.",
        });
      accounts.push({ agent: agentId, id, label, dir });
      trace("add-account", { agentId, id });
      return providers().providers.find((x) => x.id === `${agentId}@${id}`) ?? null;
    },
    removeAgentAccount: async (agentId, accountId) => {
      await delay();
      const at = accounts.findIndex((a) => a.agent === agentId && a.id === accountId);
      if (at < 0) throw new BridgeError(404, "not_found", "That account no longer exists.");
      accounts.splice(at, 1);
      trace("remove-account", { agentId, accountId });
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
        router: routerOn()
          ? { base_url: ROUTER_URL, detected: true, capabilities: ["autoroute", "route_hints", "result_headers", "budget_key"] }
          : { base_url: "", detected: false, capabilities: [] },
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
