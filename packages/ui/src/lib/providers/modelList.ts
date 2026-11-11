import type { Provider, ProviderList, ProviderModel } from "@octo/agent-client";
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
    }
  | {
      kind: "agent";
      key: string;
      /** `acp:<agent>`: the agent with its default model. */
      value: string;
      label: string;
      providerId: string;
      /** Its default model's label, when it names one. */
      detail?: string;
      /** More than one model: the row has a trailing "›" and → opens them. */
      hasModels: boolean;
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

export type PickerGroup = { providerId: string; label: string; rows: PickerRow[] };

export type PickerView =
  { level: "top"; groups: PickerGroup[]; unavailable: PickerRow[] } | { level: "agent"; agent: { id: string; label: string }; rows: PickerRow[] };

export type PickerOptions = {
  query?: string;
  /** Values left out of pickers (Settings → Models); an agent's own row is never hidden, its models can be. */
  hidden?: ReadonlySet<string>;
  /** The agent whose models are open (second level), or null. */
  agent?: string | null;
};

const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (words: string[], text: string) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

/** An agent's models, its default first (decision 58). */
export function agentModels(agent: Provider): ProviderModel[] {
  const def = agent.default_model;
  const first = def ? agent.models.find((m) => m.id === def) : undefined;
  return first ? [first, ...agent.models.filter((m) => m !== first)] : agent.models;
}

function agentModelRow(agent: Provider, m: ProviderModel, withAgent: boolean): PickerRow {
  return {
    kind: "model",
    key: `acp:${agent.id}/${m.id}`,
    value: `acp:${agent.id}/${m.id}`,
    label: m.label,
    providerId: agent.id,
    isDefault: m.id === agent.default_model,
    ...(withAgent ? { agentLabel: agent.label } : {}),
  };
}

/** The rows of the picker for `list`: only what can run, grouped by provider; not-ready providers one row each below. */
export function pickerView(list: ProviderList, opts: PickerOptions = {}): PickerView {
  const words = tokens(opts.query ?? "");
  const hidden = opts.hidden ?? new Set<string>();
  const open = opts.agent ? list.providers.find((p) => p.kind === "agent" && p.id === opts.agent && isReady(p)) : undefined;
  if (open) {
    const rows = agentModels(open)
      .filter((m) => !hidden.has(`acp:${open.id}/${m.id}`))
      .filter((m) => matches(words, `${m.label} ${m.id}`))
      .map((m) => agentModelRow(open, m, false));
    return { level: "agent", agent: { id: open.id, label: open.label }, rows };
  }
  const groups: PickerGroup[] = [];
  const unavailable: PickerRow[] = [];
  for (const p of list.providers) {
    if (!isReady(p)) {
      if (matches(words, `${p.label} ${p.id}`))
        unavailable.push({ kind: "connect", key: `connect:${p.id}`, providerId: p.id, label: p.label, state: stateText(p.state), action: connectAction(p) });
      continue;
    }
    const rows: PickerRow[] = [];
    if (p.kind === "agent") {
      const models = agentModels(p).filter((m) => !hidden.has(`acp:${p.id}/${m.id}`));
      const def = p.models.find((m) => m.id === p.default_model);
      if (matches(words, `${p.label} ${p.id}`))
        rows.push({
          kind: "agent",
          key: `acp:${p.id}`,
          value: `acp:${p.id}`,
          label: p.label,
          providerId: p.id,
          ...(def ? { detail: def.label } : {}),
          hasModels: p.models.length > 1,
        });
      // Decision 58: "copilot gpt" finds the model one level down — shown flat while searching.
      if (words.length > 0) for (const m of models) if (matches(words, `${p.label} ${p.id} ${m.label} ${m.id}`)) rows.push(agentModelRow(p, m, true));
    } else {
      for (const m of p.models) {
        if (hidden.has(m.id) || !matches(words, `${p.label} ${m.label} ${m.id}`)) continue;
        rows.push({ kind: "model", key: `${p.id}:${m.id}`, value: m.id, label: m.label, providerId: p.id, isDefault: false });
      }
    }
    if (rows.length > 0) groups.push({ providerId: p.id, label: p.label, rows });
  }
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
  | { do: "connect"; providerId: string };

/**
 * Keys of the picker list (decision 58): ↑/↓ move, → or Enter on an agent with models opens them, ← goes back (to the
 * agent's row), Enter chooses a model or opens the connect sheet of a provider that is not ready.
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
      return row?.kind === "agent" && row.hasModels ? { do: "open", agent: row.providerId } : null;
    case "ArrowLeft": {
      if (view.level !== "agent") return null;
      const at = backTo ? pickerRows(backTo).findIndex((r) => r.kind === "agent" && r.providerId === view.agent.id) : -1;
      return { do: "back", active: Math.max(0, at) };
    }
    case "Enter":
      if (!row) return null;
      if (row.kind === "connect") return { do: "connect", providerId: row.providerId };
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
      out.push({ group: p.label, value: `acp:${p.id}`, label: def ? `${p.label} (default: ${def.label})` : p.label });
      for (const m of agentModels(p))
        if (!hidden?.has(`acp:${p.id}/${m.id}`)) out.push({ group: p.label, value: `acp:${p.id}/${m.id}`, label: `${p.label} · ${m.label}` });
    } else {
      for (const m of p.models) if (!hidden?.has(m.id)) out.push({ group: p.label, value: m.id, label: m.label });
    }
  }
  return out;
}

/** The hidden-models preference: a list of setting strings (malformed text reads as none hidden). */
export const hiddenModelsCodec: Codec<string[]> = jsonCodec((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));
