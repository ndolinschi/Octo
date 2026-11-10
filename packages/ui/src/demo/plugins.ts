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
    agents: [{ id: "claude-code", label: "Claude Code", available: true }],
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
];

export function demoPlugins(enabled: boolean): Plugin[] {
  return enabled ? structuredClone(PLUGINS) : [];
}

export function demoLanguageServers(enabled: boolean): LanguageServerInfo[] {
  return demoPlugins(enabled).flatMap((p) => p.language_servers);
}
