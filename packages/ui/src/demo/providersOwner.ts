import type { Provider, ProviderModel } from "@octo/agent-client";

/**
 * `?providers=owner`: the set the owner has live (decision 89 acceptance) — Claude Code 16 models, GitHub Copilot 7, Grok 4,
 * Codex ready without models, OpenCode 12, Antigravity ready and experimental, five agents not installed, no API key.
 */
const named = (ids: readonly string[]): ProviderModel[] => ids.map((id) => ({ id, label: id, source: "advertised" }));
const numbered = (prefix: string, n: number): ProviderModel[] => named(Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`));

const CLAUDE = named([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-5",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-haiku",
]);

const agent = (id: string, label: string, state: Provider["state"], over: Partial<Provider> = {}): Provider => ({
  id,
  kind: "agent",
  label,
  state,
  reason: state === "not_installed" ? `${id}: command not found on PATH` : "",
  install_hint: `Install the ${label} command line so that \`${id}\` is on PATH.`,
  login_hint: `Log in once: run \`${id} login\`.`,
  models: [],
  default_model: "",
  flat_rate: true,
  ...over,
});

export function ownerProviders(apiReady: boolean): Provider[] {
  return [
    {
      id: "api",
      kind: "api",
      label: "Anthropic API",
      state: apiReady ? "ready" : "not_connected",
      reason: apiReady ? "" : "No API key",
      install_hint: "",
      login_hint: "",
      models: [
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", source: "catalogue" },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", source: "catalogue" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", source: "catalogue" },
      ],
      default_model: "claude-sonnet-5-5",
      flat_rate: false,
    },
    agent("claude-code", "Claude Code", "ready", { models: CLAUDE, default_model: "claude-sonnet-5-5" }),
    agent("copilot", "GitHub Copilot", "ready", { models: numbered("copilot-model", 7), default_model: "copilot-model-1" }),
    agent("grok", "Grok", "ready", { models: numbered("grok", 4), default_model: "grok-1" }),
    agent("codex", "Codex", "ready"),
    agent("opencode", "OpenCode", "ready", { models: numbered("opencode-model", 12), default_model: "opencode-model-1" }),
    agent("antigravity", "Antigravity", "ready", { experimental: true }),
    agent("cursor", "Cursor", "not_installed"),
    agent("devin", "Devin CLI", "not_installed"),
    agent("factory-droid", "Factory Droid", "not_installed"),
    agent("oh-my-pi", "Oh My Pi", "not_installed"),
    agent("pi", "Pi", "not_installed"),
  ];
}
