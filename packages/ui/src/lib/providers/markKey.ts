/**
 * Which vendor mark (a file in `assets/providers/`) an id gets, or null when it has none. Two kinds of id share one table:
 * a provider or agent id ("claude-code", "api") gets that provider's own mark; a model id ("claude-sonnet-5-5",
 * "openai/gpt-5-mini") gets the mark of the vendor that made the model. Provider ids are tried first.
 */
const PROVIDERS: Record<string, string> = {
  api: "anthropic",
  "claude-code": "claude-code",
  claude: "claude-code",
  codex: "codex",
  copilot: "copilot",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
  cursor: "cursor",
  devin: "devin",
  gemini: "gemini",
  goose: "goose",
  pi: "pi",
  zed: "zed",
};

/** The part before "/" of an OpenRouter-style model id. */
const VENDOR_PREFIX: Record<string, string> = {
  anthropic: "claude",
  openai: "openai",
  google: "gemini",
  "x-ai": "grok",
  xai: "grok",
  deepseek: "deepseek",
  mistralai: "mistral",
  mistral: "mistral",
  "meta-llama": "meta",
  meta: "meta",
  qwen: "qwen",
  alibaba: "qwen",
  moonshotai: "kimi",
  moonshot: "kimi",
  "z-ai": "zhipu",
  zhipu: "zhipu",
  openrouter: "openrouter",
};

/** The start of the model name itself. */
const MODEL_NAME: readonly (readonly [RegExp, string])[] = [
  [/^claude/, "claude"],
  [/^(?:gpt|chatgpt|o\d)(?:$|[-.\d])/, "openai"],
  [/^gemini/, "gemini"],
  [/^grok/, "grok"],
  [/^deepseek/, "deepseek"],
  [/^(?:mistral|mixtral|ministral|codestral)/, "mistral"],
  [/^llama/, "meta"],
  [/^(?:qwen|qwq)/, "qwen"],
  [/^kimi/, "kimi"],
  [/^glm/, "zhipu"],
];

export function markKeyOf(id: string): string | null {
  const lower = id.trim().toLowerCase();
  if (lower.startsWith("acp:")) {
    const rest = lower.slice(4);
    const slash = rest.indexOf("/");
    // An account of an agent ("claude-code@work") has the agent's mark.
    const agentId = baseAgent(slash >= 0 ? rest.slice(0, slash) : rest);
    const modelId = slash >= 0 ? rest.slice(slash + 1) : "";
    if (agentId && PROVIDERS[agentId]) return PROVIDERS[agentId];
    if (modelId) return markKeyOf(modelId);
    return null;
  }
  const provider = PROVIDERS[lower] ?? PROVIDERS[baseAgent(lower)];
  if (provider) return provider;
  const slash = lower.indexOf("/");
  if (slash > 0) {
    const vendor = VENDOR_PREFIX[lower.slice(0, slash)];
    if (vendor) return vendor;
  }
  const name = slash >= 0 ? lower.slice(slash + 1) : lower;
  for (const [re, key] of MODEL_NAME) if (re.test(name)) return key;
  return null;
}

/** The agent of an account id ("claude-code@work" is "claude-code"); any other id as it is. */
function baseAgent(id: string): string {
  const at = id.indexOf("@");
  return at > 0 ? id.slice(0, at) : id;
}
