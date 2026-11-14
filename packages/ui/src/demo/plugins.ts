import type { LanguageServerInfo, Plugin } from "@octo/agent-client";

/**
 * Demo plugins: one healthy plugin with two language servers and an ACP agent, and one with a
 * server whose command is missing on this machine plus a manifest error, so the Settings view
 * shows every state.
 */
const PLUGINS: Plugin[] = [
  {
    name: "web-tools",
    version: "1.4.0",
    description: "TypeScript and Go language servers, plus Claude Code as an agent",
    language_servers: [
      { id: "typescript", label: "typescript-language-server", languages: ["typescript", "javascript"], available: true },
      { id: "gopls", label: "gopls", languages: ["go"], available: true },
    ],
    agents: [
      {
        id: "claude-code",
        label: "Claude Code",
        available: true,
        logged_in: true,
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
        default_model: "claude-sonnet-5-5",
        hint: "Run `claude login` in a terminal.",
      },
      { id: "copilot", label: "GitHub Copilot", available: true, logged_in: false, hint: "Run `copilot login` in a terminal, then reopen this list." },
    ],
    tool_servers: [],
    errors: [],
  },
  {
    name: "systems",
    version: "0.2.1",
    description: "Rust language server and a local tool server",
    language_servers: [{ id: "rust-analyzer", label: "rust-analyzer", languages: ["rust"], available: false }],
    agents: [{ id: "codex", label: "Codex", available: false }],
    tool_servers: [{ url: "http://127.0.0.1:9000" }],
    errors: ['languageServers[1]: duplicate id "gopls" (already defined by web-tools)'],
  },
  {
    name: "python",
    version: "0.9.3",
    description: "Python type checking and linting",
    language_servers: [
      { id: "pyright", label: "pyright", languages: ["python"], available: true },
      { id: "ruff", label: "ruff server", languages: ["python"], available: true },
    ],
    agents: [],
    tool_servers: [],
    errors: [],
  },
  {
    name: "review-kit",
    version: "1.0.0",
    description: "A local review agent and the team's docs search",
    language_servers: [],
    agents: [{ id: "reviewer", label: "Local reviewer", available: true }],
    tool_servers: [{ url: "http://127.0.0.1:9100/mcp" }, { url: "https://docs.internal.example/mcp" }],
    errors: [],
  },
  {
    name: "data-tools",
    version: "0.4.0",
    description: "SQL and YAML language servers",
    language_servers: [
      { id: "sqls", label: "sqls", languages: ["sql"], available: false },
      { id: "yaml-language-server", label: "yaml-language-server", languages: ["yaml"], available: true },
    ],
    agents: [],
    tool_servers: [],
    errors: [],
  },
];

export function demoPlugins(enabled: boolean): Plugin[] {
  return enabled ? structuredClone(PLUGINS) : [];
}

export function demoLanguageServers(enabled: boolean): LanguageServerInfo[] {
  return demoPlugins(enabled).flatMap((p) => p.language_servers);
}
