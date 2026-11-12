import type { Provider, ProviderList, ProviderModel, ProviderModelSource } from "@octo/agent-client";
import { agentModelLabel, modelLabel } from "../models";
import { jsonCodec, type Codec } from "../storage";
import { connectAction, isReady, stateText } from "./providers";

/**
 * The model picker as data (decisions 53 a and 58), React-free: what a picker renders and how its keys move. The
 * picker component renders `PickerRow`s; it never decides what can run.
 */
export type PickerRow =
  | {
      kind: "model";
      key: string;
      /** The setting it writes: a model id, or `acp:<agent>/<model>`. */
      value: string;
      label: string;
      providerId: string;
      /** The agent's own default model (decision 58: listed first, marked "default"). */
      isDefault: boolean;
      /** An agent model found by a top-level search: shown as "Agent · Model". */
      agentLabel?: string;
      /** The agent's latest session did not advertise it any more (kept, dimmed: "not offered in the last session"). */
      stale?: boolean;
      /** A name the user added: it can be removed again (an "×" on the row). */
      removable?: boolean;
      /** Where the name came from, for the tooltip ("advertised by the agent", "added by you"). */
      source?: ProviderModelSource;
    }
  | {
      kind: "agent";
      key: string;
      /** `acp:<agent>`: the agent with its default model. */
      value: string;
      label: string;
      providerId: string;
      /** The model chosen for this agent now, else its default model, when it names one (dim, right-aligned). */
      detail?: string;
    }
  | {
      /** Second level, first row: no model named, the agent decides (`acp:<agent>`). */
      kind: "default";
      key: string;
      value: string;
      label: string;
      providerId: string;
      /** The agent's default model, when it names one ("currently Sonnet 5.5"). */
      detail?: string;
    }
  | {
      /** Second level, last row: "Other model…" turns into a field where a name is typed. */
      kind: "other";
      key: string;
      label: string;
      providerId: string;
    }
  | {
      kind: "connect";
      key: string;
      providerId: string;
      label: string;
      /** "Not logged in", "Not installed", … */
      state: string;
      /** The row's action: "Connect", "Reconnect" or "How to connect". */
      action: string;
    };

export type PickerGroup = { key: string; label: string; rows: PickerRow[] };

/** What the second level's header needs of the agent: its name, and what the last model discovery said. */
export type PickerAgent = { id: string; label: string; error: string; refreshedAt: string };

export type PickerView = { level: "top"; groups: PickerGroup[]; unavailable: PickerRow[] } | { level: "agent"; agent: PickerAgent; rows: PickerRow[] };

export type PickerOptions = {
  query?: string;
  /** Values left out of pickers (Settings → Models); an agent's own row is never hidden, its models can be. */
  hidden?: ReadonlySet<string>;
  /** The agent whose models are open (second level), or null. */
  agent?: string | null;
  /** The setting being changed: the agent row shows its chosen model on the right. */
  current?: string;
  /** Names the user typed for an agent (this browser's memory; the harness's own list wins when it has the name too). */
  custom?: Readonly<Record<string, readonly string[]>>;
};

const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (words: string[], text: string) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

/** An agent's models plus the names typed for it here (deduplicated by id), its default first (decision 58). */
export function agentModels(agent: Provider, custom?: PickerOptions["custom"]): ProviderModel[] {
  const known = new Set(agent.models.map((m) => m.id));
  const extra = (custom?.[agent.id] ?? []).filter((id) => !known.has(id)).map((id): ProviderModel => ({ id, label: id, source: "custom" }));
  const all = [...agent.models, ...extra];
  const def = agent.default_model;
  const first = def ? all.find((m) => m.id === def) : undefined;
  return first ? [first, ...all.filter((m) => m !== first)] : all;
}

function agentModelRow(agent: Provider, m: ProviderModel, withAgent: boolean): PickerRow {
  return {
    kind: "model",
    key: `acp:${agent.id}/${m.id}`,
    value: `acp:${agent.id}/${m.id}`,
    label: agentModelLabel(m),
    providerId: agent.id,
    isDefault: m.id === agent.default_model,
    source: m.source,
    ...(withAgent ? { agentLabel: agent.label } : {}),
    ...(m.stale ? { stale: true } : {}),
    ...(m.source === "custom" ? { removable: true } : {}),
  };
}

/** The model an `acp:<agent>/<model>` setting names for `agentId`, if it is that agent's. */
function chosenModel(current: string | undefined, agentId: string): string | null {
  if (!current?.startsWith("acp:")) return null;
  const [id, model] = current.slice(4).split("/", 2);
  return id === agentId && model ? model : null;
}

/**
 * The rows of the picker for `list`: only what can run. Top level: the models of the API and the router grouped by
 * provider, then one flat "Agents" group with one row per ready agent (every one opens a second level, even with no known
 * model: decision 58); providers that are not ready are one row each below, never selectable. Second level: "Default",
 * the known models, "Other model…".
 */
export function pickerView(list: ProviderList, opts: PickerOptions = {}): PickerView {
  const words = tokens(opts.query ?? "");
  const hidden = opts.hidden ?? new Set<string>();
  const open = opts.agent ? list.providers.find((p) => p.kind === "agent" && p.id === opts.agent && isReady(p)) : undefined;
  if (open) {
    const rows: PickerRow[] = [];
    const def = open.models.find((m) => m.id === open.default_model);
    if (matches(words, "default the agent decides"))
      rows.push({
        kind: "default",
        key: `acp:${open.id}`,
        value: `acp:${open.id}`,
        label: "Default (the agent decides)",
        providerId: open.id,
        ...(def ? { detail: agentModelLabel(def) } : {}),
      });
    for (const m of agentModels(open, opts.custom))
      if (!hidden.has(`acp:${open.id}/${m.id}`) && matches(words, `${m.label} ${m.id}`)) rows.push(agentModelRow(open, m, false));
    if (words.length === 0) rows.push({ kind: "other", key: `other:${open.id}`, label: "Other model…", providerId: open.id });
    return { level: "agent", agent: { id: open.id, label: open.label, error: open.models_error ?? "", refreshedAt: open.models_refreshed_at ?? "" }, rows };
  }
  const groups: PickerGroup[] = [];
  const agents: PickerRow[] = [];
  const unavailable: PickerRow[] = [];
  for (const p of list.providers) {
    if (!isReady(p)) {
      if (matches(words, `${p.label} ${p.id}`))
        unavailable.push({ kind: "connect", key: `connect:${p.id}`, providerId: p.id, label: p.label, state: stateText(p.state), action: connectAction(p) });
      continue;
    }
    if (p.kind === "agent") {
      const models = agentModels(p, opts.custom).filter((m) => !hidden.has(`acp:${p.id}/${m.id}`));
      const chosen = chosenModel(opts.current, p.id);
      const shown = chosen ? models.find((m) => m.id === chosen) : undefined;
      const def = p.models.find((m) => m.id === p.default_model);
      const detail = chosen ? (shown ? agentModelLabel(shown) : chosen) : def ? agentModelLabel(def) : undefined;
      if (matches(words, `${p.label} ${p.id}`))
        agents.push({ kind: "agent", key: `acp:${p.id}`, value: `acp:${p.id}`, label: p.label, providerId: p.id, ...(detail ? { detail } : {}) });
      // Decision 58: "copilot gpt" finds the model one level down — shown flat while searching.
      if (words.length > 0) for (const m of models) if (matches(words, `${p.label} ${p.id} ${m.label} ${m.id}`)) agents.push(agentModelRow(p, m, true));
      continue;
    }
    const rows: PickerRow[] = [];
    for (const m of p.models) {
      if (hidden.has(m.id) || !matches(words, `${p.label} ${m.label} ${m.id}`)) continue;
      rows.push({ kind: "model", key: `${p.id}:${m.id}`, value: m.id, label: modelLabel(m), providerId: p.id, isDefault: false });
    }
    if (rows.length > 0) groups.push({ key: p.id, label: p.label, rows });
  }
  if (agents.length > 0) groups.push({ key: "agents", label: "Agents", rows: agents });
  return { level: "top", groups, unavailable };
}

/** Every row in display order (the order the arrow keys walk). */
export function pickerRows(view: PickerView): PickerRow[] {
  return view.level === "agent" ? view.rows : [...view.groups.flatMap((g) => g.rows), ...view.unavailable];
}

/** What the picker does for a key. `null`: the key is not the picker's. */
export type PickerStep =
  | { do: "move"; active: number }
  | { do: "open"; agent: string }
  | { do: "back"; active: number }
  | { do: "choose"; value: string }
  | { do: "other"; agent: string }
  | { do: "connect"; providerId: string };

/**
 * Keys of the picker list (decision 58): ↑/↓ move, → or Enter on an agent opens its models, ← goes back (to the agent's
 * row), Enter chooses a model, starts "Other model…", or opens the connect sheet of a provider that is not ready.
 */
export function pickerKey(view: PickerView, active: number, key: string, backTo?: PickerView): PickerStep | null {
  const rows = pickerRows(view);
  const row = rows[active];
  switch (key) {
    case "ArrowDown":
      return rows.length ? { do: "move", active: (active + 1) % rows.length } : null;
    case "ArrowUp":
      return rows.length ? { do: "move", active: (active - 1 + rows.length) % rows.length } : null;
    case "ArrowRight":
      return row?.kind === "agent" ? { do: "open", agent: row.providerId } : null;
    case "ArrowLeft": {
      if (view.level !== "agent") return null;
      const at = backTo ? pickerRows(backTo).findIndex((r) => r.kind === "agent" && r.providerId === view.agent.id) : -1;
      return { do: "back", active: Math.max(0, at) };
    }
    case "Enter":
      if (!row) return null;
      if (row.kind === "connect") return { do: "connect", providerId: row.providerId };
      if (row.kind === "agent") return { do: "open", agent: row.providerId };
      if (row.kind === "other") return { do: "other", agent: row.providerId };
      return { do: "choose", value: row.value };
    default:
      return null;
  }
}

/** Every choosable value with its label, flat (selects in Settings → Models). */
export function choosable(list: ProviderList, hidden?: ReadonlySet<string>): { group: string; value: string; label: string }[] {
  const out: { group: string; value: string; label: string }[] = [];
  for (const p of list.providers) {
    if (!isReady(p)) continue;
    if (p.kind === "agent") {
      const def = p.models.find((m) => m.id === p.default_model);
      out.push({ group: p.label, value: `acp:${p.id}`, label: def ? `${p.label} (default: ${modelLabel(def)})` : p.label });
      for (const m of agentModels(p))
        if (!hidden?.has(`acp:${p.id}/${m.id}`)) out.push({ group: p.label, value: `acp:${p.id}/${m.id}`, label: `${p.label} · ${agentModelLabel(m)}` });
    } else {
      for (const m of p.models) if (!hidden?.has(m.id)) out.push({ group: p.label, value: m.id, label: modelLabel(m) });
    }
  }
  return out;
}

/** The hidden-models preference: a list of setting strings (malformed text reads as none hidden). */
export const hiddenModelsCodec: Codec<string[]> = jsonCodec((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));

/** Names typed for agents, by agent id (malformed text reads as none). */
export const customModelsCodec: Codec<Record<string, string[]>> = jsonCodec((v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v).flatMap(([id, names]) =>
      Array.isArray(names) ? [[id, names.filter((n): n is string => typeof n === "string" && n.trim() !== "")]] : [],
    ),
  );
});

/** The model name as typed, cleaned: one word, no surrounding space; "" when there is nothing to keep. */
export function cleanModelName(text: string): string {
  const t = text.trim().replace(/^acp:[^/]*\//, "");
  return /\s/.test(t) ? "" : t.slice(0, 120);
}

/** `names` with `name` added (newest last, no duplicates, at most 20); unchanged when the name is empty. */
export function withCustomModel(names: readonly string[], name: string): string[] {
  const n = cleanModelName(name);
  if (!n || names.includes(n)) return [...names];
  return [...names, n].slice(-20);
}

export const withoutCustomModel = (names: readonly string[], name: string): string[] => names.filter((x) => x !== name);
