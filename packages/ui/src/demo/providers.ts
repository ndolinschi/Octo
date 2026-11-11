import {
  BridgeError,
  type Bridge,
  type Diagnostics,
  type Provider,
  type ProviderList,
  type Setting,
  type SettingsUpdate,
  type SettingsView,
} from "@octo/agent-client";

/**
 * Demo providers, settings and diagnostics (decisions 53, 59; R1.5). Default: Claude Code ready, GitHub Copilot not
 * logged in, Grok not installed, no API key, no router. `?providers=none` (or `none: true`): Claude Code is not
 * logged in either, so Home shows the connect screen; entering any API key connects the API.
 */
export type DemoProvidersOptions = { none?: boolean };

const CLAUDE_LOGIN = "Log in once: run `claude` and type /login (or run `claude auth login`).";
const CLAUDE_INSTALL = "Install Node.js and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code`";
const COPILOT_LOGIN =
  'Log in once: run `copilot` and type /login, or start the harness with COPILOT_GITHUB_TOKEN set to a fine-grained token that has the "Copilot Requests" permission.';
const COPILOT_INSTALL = "Install the GitHub Copilot CLI: `npm install -g @github/copilot` (needs Node.js 22 or newer and a Copilot plan)";
const GROK_LOGIN = "Log in once in the browser: run `grok login`. An XAI_API_KEY in the harness environment switches Grok to per-token billing.";
const GROK_INSTALL = "Install the Grok CLI so that `grok` is on PATH (from x.ai).";

const API_MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
];

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

export function demoProviders(options: DemoProvidersOptions = {}): Required<Pick<Bridge, "listProviders" | "getSettings" | "putSettings" | "getDiagnostics">> {
  const none = options.none ?? noneFromUrl();
  // The file: id → value. Secrets are kept only to know they are set; they are never returned.
  const file = new Map<string, string | boolean | string[]>([["HARNESS_ACP_TRACE", false]]);
  const restart = new Set<string>();
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

  const providers = (): ProviderList => {
    const apiReady = file.has("ANTHROPIC_API_KEY");
    const routerOn = file.get("OCTO_ROUTER_ENABLED") === true;
    const list: Provider[] = [
      {
        id: "anthropic-api",
        kind: "api",
        label: "Anthropic API",
        state: apiReady ? "ready" : "not_connected",
        ...(apiReady ? {} : { reason: "No API key" }),
        models: apiReady ? API_MODELS : [],
      },
      {
        id: "octo-router",
        kind: "router",
        label: "Octo router",
        state: "not_connected",
        reason: routerOn ? "Switched on: starts with the app's next start" : "Switched off",
        models: [],
      },
      {
        id: "claude-code",
        kind: "agent",
        label: "Claude Code",
        state: none ? "not_logged_in" : "ready",
        ...(none ? { reason: "The login probe says it is not logged in" } : {}),
        install_hint: CLAUDE_INSTALL,
        login_hint: CLAUDE_LOGIN,
        models: [
          { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
          { id: "claude-opus-5-5", label: "Opus 5.5" },
          { id: "claude-haiku-5-5", label: "Haiku 5.5" },
        ],
        default_model: "claude-sonnet-5-5",
      },
      {
        id: "copilot",
        kind: "agent",
        label: "GitHub Copilot",
        state: "not_logged_in",
        reason: "The login probe says it is not logged in",
        install_hint: COPILOT_INSTALL,
        login_hint: COPILOT_LOGIN,
        models: [
          { id: "gpt-5", label: "GPT-5" },
          { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        ],
      },
      {
        id: "grok",
        kind: "agent",
        label: "Grok",
        state: "not_installed",
        reason: "grok: command not found on PATH",
        install_hint: GROK_INSTALL,
        login_hint: GROK_LOGIN,
        models: [],
      },
    ];
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
      providers: list,
    };
  };

  return {
    listProviders: async () => (await delay(), providers()),
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
            probe: { ran: a.state !== "not_installed", logged_in: a.state === "not_installed" ? null : a.state === "ready", reason: a.reason ?? "" },
            ...(a.login_hint ? { login_hint: a.login_hint } : {}),
            ...(a.install_hint ? { install_hint: a.install_hint } : {}),
            flat_rate: true,
          })),
        acp_trace: { enabled: file.get("HARNESS_ACP_TRACE") === true, dir: "~/Library/Application Support/Octo/harness/traces", files: [] },
        log_tail: ['level=INFO msg="harness serve" addr=127.0.0.1:8790', 'level=INFO msg="plugins loaded" agents=3'],
        problems: p.connected === 0 ? ["No provider is connected: log in an agent or set an API key."] : [],
      };
    },
  };
}
