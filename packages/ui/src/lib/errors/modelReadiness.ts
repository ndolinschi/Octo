import type { Provider, ProviderList } from "@octo/agent-client";
import { canRun, chipLabel } from "../providers";
import { commandOf } from "./plain";

/** A provider that cannot run a model the project is set to use, said in the person's words (never a dead end: creating goes on). */
export type NotReady = {
  /** The agent id when "Check again" can re-read its login; null for the API, the router or a model the agent no longer lists. */
  agentId: string | null;
  /** The whole sentence, with the way forward. */
  text: string;
  /** The login command to copy, when the agent is not logged in. */
  command?: string;
};

function sentenceOf(p: Provider): { head: string; command?: string } {
  if (p.state === "not_logged_in") {
    const command = p.problem?.command?.trim() || commandOf(p.login_hint) || undefined;
    return { head: `${p.label} is not logged in.`, ...(command ? { command } : {}) };
  }
  if (p.state === "not_installed") return { head: `${p.label} is not installed.` };
  if (p.state === "not_supported") return { head: p.reason || `${p.label} does not work with Octo yet.` };
  return { head: `${p.label} is not connected.` };
}

/**
 * Decision 2026-11-15: a project is a folder and settings, so a model that cannot run now is a notice with actions and never a
 * block. One entry per provider (or per model an agent no longer lists), in the order of `models`. Empty when all can run.
 */
export function notReady(list: ProviderList, models: readonly string[], editing: boolean): NotReady[] {
  const out: NotReady[] = [];
  const seen = new Set<string>();
  for (const value of models) {
    if (!value || canRun(list, value) || seen.has(value)) continue;
    const id = value.startsWith("acp:") ? value.slice(4).split("/", 1)[0] : undefined;
    const agent = id ? list.providers.find((p) => p.kind === "agent" && p.id === id) : undefined;
    const provider = agent ?? list.providers.find((p) => p.kind !== "agent");
    const key = agent && agent.state !== "ready" ? agent.id : provider && !agent ? provider.id : value;
    if (seen.has(key)) continue;
    seen.add(value);
    seen.add(key);
    const after = editing
      ? "Log in or choose another model before your next request."
      : "You can create the project now and sort it out later, or choose another model.";
    if (agent?.state === "ready") {
      out.push({
        agentId: null,
        text: `${chipLabel(value, list)} is not on ${agent.label}'s list right now. ${editing ? "Choose another model before your next request." : "You can create the project now, or choose another model."}`,
      });
      continue;
    }
    if (!provider) {
      out.push({ agentId: null, text: `${chipLabel(value, list)} cannot run yet. ${after}` });
      continue;
    }
    const s = sentenceOf(provider);
    const loggedOut = provider.state === "not_logged_in";
    const text = loggedOut
      ? `${s.head} ${editing ? "Log in, or choose another model, before your next request." : "You can create the project now and log in later, or choose another model."}`
      : `${s.head} ${after}`;
    out.push({ agentId: provider.kind === "agent" ? provider.id : null, text, ...(s.command ? { command: s.command } : {}) });
  }
  return out;
}
