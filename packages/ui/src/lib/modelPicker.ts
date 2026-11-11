import type { AcpOrchestratorChoice, Models, PluginAgent } from "@octo/agent-client";
import { displayId, modelName } from "./models";

/** One choice of the model picker (decision 27), React-free; `components/shared/ModelPicker` adds glyphs and actions. */
export type ModelChoice = {
  /** The setting it writes: a model id or an `acp:` value. */
  value: string;
  section: "Tiers" | "Models" | "Agents";
  label: string;
  detail?: string;
  /** A logged-out agent: shown, not choosable, with the plugin's login hint. */
  disabled?: boolean;
  hint?: string;
  title?: string;
};

export type ModelChoiceInput = {
  /** The project's tiers (the orchestrator picks among them); omit for a tier's own picker. */
  tiers?: Pick<Models, "fast" | "balanced" | "deep">;
  /** Ids the harness knows: the project's models and the bridge's defaults. */
  known: readonly string[];
  acp: readonly AcpOrchestratorChoice[];
  /** The plugins' agents, for their login state and hint. */
  agents: readonly Pick<PluginAgent, "id" | "logged_in" | "hint" | "available">[];
};

const TIER_ROWS = [
  ["balanced", "Balanced"],
  ["fast", "Fast"],
  ["deep", "Deep"],
] as const;

/** Tiers (each with the model it maps to), every model the harness lists, then the ACP agents and their models. */
export function modelChoices(input: ModelChoiceInput): ModelChoice[] {
  const out: ModelChoice[] = [];
  if (input.tiers) {
    for (const [key, label] of TIER_ROWS) {
      const value = input.tiers[key];
      if (value) out.push({ value, section: "Tiers", label, detail: modelName(value, input.acp), title: `${label} tier: ${value}` });
    }
  }
  const ids = [...new Set(input.known.filter((m) => m.trim() && !m.startsWith("acp:")))];
  for (const id of ids) out.push({ value: id, section: "Models", label: displayId(id), ...(displayId(id) !== id ? { detail: id } : {}), title: id });
  for (const a of input.acp) {
    const plugin = input.agents.find((p) => p.id === a.id);
    const loggedOut = plugin?.logged_in === false;
    const lock = loggedOut ? { disabled: true, hint: "logged out", title: plugin.hint ? `Not logged in. ${plugin.hint}` : "Not logged in" } : {};
    out.push({
      value: a.value,
      section: "Agents",
      label: a.label,
      detail: "subscription",
      ...(a.default_model ? { title: `${a.label}, its default model (${displayId(a.default_model)})` } : {}),
      ...lock,
    });
    for (const m of a.models) {
      if (m === a.default_model) continue;
      out.push({ value: `${a.value}/${m}`, section: "Agents", label: `${a.label} · ${displayId(m)}`, detail: "subscription", ...lock });
    }
  }
  return out;
}

/** A row's identity in the list: a tier row and a model row may write the same value. */
export function choiceKey(c: Pick<ModelChoice, "section" | "value" | "label">): string {
  return `${c.section}:${c.value}:${c.label}`;
}

/** Favourites first (in the order starred), as their own section; the rest unchanged. */
export function withFavourites(choices: readonly ModelChoice[], favourites: readonly string[]): { favourites: ModelChoice[]; rest: ModelChoice[] } {
  const fav = favourites.flatMap((v) => {
    const hit = choices.find((c) => c.value === v && c.section !== "Tiers");
    return hit ? [hit] : [];
  });
  return { favourites: fav, rest: [...choices] };
}

/** Starring toggles a value in the list (most recent last). */
export function toggleFavourite(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** The favourites preference: a list of setting strings, anything else dropped. */
export function favouritesFrom(parsed: unknown): string[] {
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 300).slice(0, 50) : [];
}
