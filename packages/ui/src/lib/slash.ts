import type { OctoSlashCommand, SlashCommands } from "@octo/agent-client";
import { matchScore } from "./match";

/** B11: one row of the slash menu. */
export type SlashRow = {
  id: string;
  group: "octo" | "agent";
  name: string;
  description: string;
  args?: string | undefined;
  available: boolean;
  reason?: string | undefined;
};
export type SlashGroup = { label: string; rows: SlashRow[] };

/** The Octo commands a harness without `getSlashCommands` still gets (the UI-side ones only). */
export const OCTO_FALLBACK: OctoSlashCommand[] = [
  { name: "mode", description: "Choose Agent, Ask or Plan for the next message", args: "ask|plan|agent", available: true, endpoint: "ui:mode" },
  { name: "model", description: "Choose the model", available: true, endpoint: "ui:model" },
  { name: "memory", description: "Open what the project remembers", available: true, endpoint: "ui:memory" },
  { name: "settings", description: "Open the project's settings", available: true, endpoint: "ui:settings" },
  { name: "help", description: "What these commands do", available: true, endpoint: "ui:help" },
];

/** The word after a `/` at the very start of the text, up to the caret; null when the text does not start with a slash command being typed. */
export function slashQuery(text: string, caret: number): string | null {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? (m[1] ?? "") : null;
}

/** `/name rest` split into its parts; null for text that is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** An Octo command named by `text` that the UI runs itself instead of sending (null for an agent's command or plain text). */
export function octoCommandFor(text: string, cmds: SlashCommands | null): { command: OctoSlashCommand; args: string } | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const command = (cmds?.octo ?? OCTO_FALLBACK).find((c) => c.name === parsed.name);
  return command?.available ? { command, args: parsed.args } : null;
}

/** The menu's two groups (Octo commands, then the agent's under its name), filtered and ranked by `query`; unavailable rows stay, dimmed. */
export function slashGroups(cmds: SlashCommands | null, query: string): { groups: SlashGroup[]; rows: SlashRow[] } {
  const octo: SlashRow[] = (cmds?.octo ?? OCTO_FALLBACK).map((c) => ({
    id: `octo:${c.name}`,
    group: "octo",
    name: c.name,
    description: c.description,
    args: c.args,
    available: c.available,
    reason: c.reason,
  }));
  const agent: SlashRow[] = (cmds?.agent?.commands ?? []).map((c) => ({
    id: `agent:${c.name}`,
    group: "agent",
    name: c.name,
    description: c.description,
    args: c.input_hint || undefined,
    available: true,
    reason: undefined,
  }));
  const rank = (rows: SlashRow[]) =>
    rows
      .map((row, i) => ({ row, i, s: matchScore(query, row.name) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.row);
  const groups: SlashGroup[] = [];
  const o = rank(octo);
  if (o.length) groups.push({ label: "Octo", rows: o });
  const a = rank(agent);
  if (a.length && cmds?.agent) groups.push({ label: cmds.agent.label, rows: a });
  return { groups, rows: groups.flatMap((g) => g.rows) };
}
