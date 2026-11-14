import type { Plugin } from "@octo/agent-client";

const DUPLICATE = /^(languageServers|agents)\[\d+\]: duplicate (?:language server |agent )?id "([^"]+)"(?: \(already defined by ([^)]+)\))?/;
const PART: Record<string, string> = { languageServers: "language server", agents: "agent", toolServers: "tool server" };

/**
 * B9: a plugin manifest problem in plain words (the raw text stays under Details). A duplicate id names both plugins and
 * which one is used (the harness keeps the first and skips the other); anything else says which part of which plugin is wrong.
 */
export function plainPluginProblem(plugin: string, raw: string, plugins: readonly Pick<Plugin, "name" | "language_servers" | "agents">[]): string {
  const dup = DUPLICATE.exec(raw);
  if (dup) {
    const [, part = "", id = "", by] = dup;
    const owner =
      by ??
      plugins.find((p) => p.name !== plugin && (part === "agents" ? p.agents.some((a) => a.id === id) : p.language_servers.some((s) => s.id === id)))?.name;
    const what = `the ${id} ${PART[part] ?? "entry"}`;
    return owner ? `Two plugins define ${what}; the one from ${owner} is used.` : `${plugin} defines ${what} twice; the first one is used.`;
  }
  const part = /^(languageServers|agents|toolServers)\[\d+\]/.exec(raw)?.[1];
  return part ? `One ${PART[part] ?? "entry"} in ${plugin} is set up wrongly and was skipped.` : `${plugin} could not be loaded completely.`;
}
