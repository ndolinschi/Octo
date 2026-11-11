import type { BridgeConfig, Models, Plugin } from "@octo/agent-client";
import { modelLabel } from "../primitives/Status";

/** One choosable model: what is stored (`value`), what is shown (`label`), the raw id for the tooltip. */
export type PickerModel = { value: string; label: string; id: string; isDefault: boolean };

/**
 * An agent (ACP, subscription) in the picker (decision 58). `value` is `acp:<id>` (its default model). A ready agent
 * with more than one model opens a second level; one that is not ready is one disabled row with its hint.
 */
export type PickerAgent = { id: string; label: string; value: string; ready: boolean; hint: string | null; models: PickerModel[] };

export type PickerData = {
  /** Messages API models (the built-in loop). Empty when it cannot run. */
  models: PickerModel[];
  agents: PickerAgent[];
};

/** A row of a flattened, searched list: a model, an agent, or an agent's model ("Claude Code · Opus"). */
export type PickerRow =
  | { kind: "model"; key: string; model: PickerModel }
  | { kind: "agent"; key: string; agent: PickerAgent }
  | { kind: "agent-model"; key: string; agent: PickerAgent; model: PickerModel };

export type PickerSources = {
  config: BridgeConfig | null;
  plugins: Plugin[] | null;
  project: Models | undefined;
  /** The built-in loop can run (an API key or router is set). Unknown → true: only what the store knows is hidden. */
  builtinAvailable?: boolean;
};

export type ModelRef = { kind: "api"; model: string } | { kind: "acp"; agent: string; model: string | null };

export function parseModelRef(value: string): ModelRef {
  if (!value.startsWith("acp:")) return { kind: "api", model: value };
  const rest = value.slice(4);
  const slash = rest.indexOf("/");
  return slash < 0 ? { kind: "acp", agent: rest, model: null } : { kind: "acp", agent: rest.slice(0, slash), model: rest.slice(slash + 1) || null };
}

/** An agent model's display name: Claude ids as everywhere ("Opus 4.1"), short names capitalised ("Opus", "GPT-5"). */
export function agentModelLabel(id: string): string {
  if (id.startsWith("claude-")) return modelLabel(id);
  if (/^gpt/i.test(id)) return id.replace(/^gpt/i, "GPT");
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Everything that can run, from what the store has today (config defaults, the project's models, plugin agents). */
export function buildPickerData(src: PickerSources): PickerData {
  const builtin = src.builtinAvailable ?? true;
  const ids = builtin
    ? [
        src.project?.orchestrator,
        src.project?.deep,
        src.project?.balanced,
        src.project?.fast,
        ...Object.values(src.config?.default_models ?? {}).filter((v) => typeof v === "string"),
      ]
    : [];
  const apiIds = [...new Set(ids.filter((m): m is string => typeof m === "string" && m.trim() !== "" && !m.startsWith("acp:")))];
  const models = apiIds.map((id) => ({ value: id, label: modelLabel(id), id, isDefault: false }));

  const pluginAgents = new Map((src.plugins ?? []).flatMap((p) => p.agents.map((a) => [a.id, a] as const)));
  const choices = src.config?.acp_orchestrators;
  // The harness lists the agents that can run an orchestrator; an older one does not, then plugin agents stand in.
  const order = choices ? choices.map((c) => c.id) : [...pluginAgents.keys()];
  const agents: PickerAgent[] = order.map((id) => {
    const choice = choices?.find((c) => c.id === id);
    const plugin = pluginAgents.get(id);
    const label = choice?.label ?? plugin?.label ?? titleCase(id);
    const installed = plugin ? plugin.available : true;
    const loggedIn = plugin?.logged_in !== false;
    const ready = installed && loggedIn;
    const hint = ready ? null : (plugin?.hint ?? (installed ? "Not logged in" : "Not installed"));
    const defaultModel = choice?.default_model ?? plugin?.default_model ?? null;
    const names = [...new Set([defaultModel, ...(choice?.models ?? []), ...(plugin?.models ?? [])].filter((m): m is string => Boolean(m)))];
    return {
      id,
      label,
      value: `acp:${id}`,
      ready,
      hint,
      models: names.map((m) => ({ value: `acp:${id}/${m}`, label: agentModelLabel(m), id: m, isDefault: m === defaultModel })),
    };
  });
  return { models, agents };
}

/** The chip's words: "Claude Code · Opus", "Claude Code", "Sonnet 5.5". */
export function chipLabel(value: string, data: PickerData): string {
  const ref = parseModelRef(value);
  if (ref.kind === "api") return modelLabel(value);
  const agent = data.agents.find((a) => a.id === ref.agent);
  const name = agent?.label ?? titleCase(ref.agent);
  return ref.model ? `${name} · ${agentModelLabel(ref.model)}` : name;
}

const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay: string, words: string[]) => {
  const h = hay.toLowerCase();
  return words.every((w) => h.includes(w));
};

/**
 * The rows of one level. Top level without a query: models, then agents. Inside an agent: its models. With a query
 * the levels flatten and every word must match ("copilot gpt" finds "Copilot · GPT-5").
 */
export function pickerRows(data: PickerData, query: string, inside: string | null): PickerRow[] {
  const words = tokens(query);
  if (inside !== null) {
    const agent = data.agents.find((a) => a.id === inside);
    if (!agent) return [];
    return agent.models.filter((m) => matches(m.label, words)).map((m) => ({ kind: "agent-model", key: m.value, agent, model: m }));
  }
  const rows: PickerRow[] = data.models.filter((m) => matches(`${m.label} ${m.id}`, words)).map((m) => ({ kind: "model", key: m.value, model: m }));
  for (const agent of data.agents) {
    if (!words.length || matches(agent.label, words)) rows.push({ kind: "agent", key: agent.value, agent });
    if (!words.length || !agent.ready) continue;
    for (const m of agent.models) {
      if (matches(`${agent.label} ${m.label} ${m.id}`, words) && !matches(agent.label, words))
        rows.push({ kind: "agent-model", key: m.value, agent, model: m });
    }
  }
  return rows;
}

/** An agent row opens a second level only when it is ready and has more than one model. */
export const opensLevel = (agent: PickerAgent) => agent.ready && agent.models.length > 1;
