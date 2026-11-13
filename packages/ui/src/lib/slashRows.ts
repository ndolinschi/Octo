import type { SlashCommands } from "@octo/agent-client";
import { matchScore } from "./match";
import { OCTO_FALLBACK, type SlashGroup, type SlashRow } from "./slash";

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
