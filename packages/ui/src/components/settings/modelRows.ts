import type { ProviderList } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { parseAcp } from "../../lib/models";
import { canRun, chipLabel, choosable, isReady } from "../../lib/providers";
import type { SelectOption } from "../primitives/Select";

/** The four models a project starts with, as the harness stores them (`HARNESS_MODEL_*`) and as a project carries them. */
export const MODEL_ROWS = [
  {
    id: SETTING_IDS.modelOrchestrator,
    field: "orchestrator",
    rowId: "default-orchestrator",
    title: "Default model",
    description: "Answers in projects created from now on.",
    projectDescription: "Answers in this project.",
  },
  {
    id: SETTING_IDS.modelFast,
    field: "fast",
    rowId: "tier-fast",
    title: "Fast tier",
    description: "Small, quick tasks handed to an agent.",
    projectDescription: "Small, quick tasks handed to an agent.",
  },
  {
    id: SETTING_IDS.modelBalanced,
    field: "balanced",
    rowId: "tiers",
    title: "Balanced tier",
    description: "Most work handed to an agent.",
    projectDescription: "Most work handed to an agent.",
  },
  {
    id: SETTING_IDS.modelDeep,
    field: "deep",
    rowId: "tier-deep",
    title: "Deep tier",
    description: "Hard problems that need the strongest model.",
    projectDescription: "Hard problems that need the strongest model.",
  },
] as const;

export type ModelRow = (typeof MODEL_ROWS)[number];

/** B7: what a tier is, said once where the tiers are set (Models), in the words the provider detail and Details use too. */
export const TIERS_NOTE = "Each task handed to an agent gets a tier by difficulty; that tier's model runs it.";

/**
 * A3: a model that can run in place of `value`, on a connected agent: the same model when the agent lists it (Claude Code runs
 * "claude-sonnet-5-5"), else a model whose name the value's name contains ("Sonnet 5.5" in "Claude Sonnet 5.5"), else the
 * agent's own default (`acp:<id>`). Null when `value` can run or no agent is ready.
 */
export function runnableSwap(list: ProviderList, value: string): string | null {
  if (!value || canRun(list, value)) return null;
  const wanted = chipLabel(value, list).toLowerCase();
  const bare = parseAcp(value)?.model ?? (value.startsWith("acp:") ? "" : value);
  const agents = list.providers.filter((p) => p.kind === "agent" && isReady(p));
  for (const a of agents) {
    const same = a.models.find((m) => m.id === bare || (m.label.length > 2 && wanted.includes(m.label.toLowerCase())));
    if (same) return `acp:${a.id}/${same.id}`;
  }
  const first = agents.find((a) => a.models.length > 0) ?? agents[0];
  return first ? `acp:${first.id}` : null;
}

/** What a model select offers: every model a connected provider runs (grouped by provider), plus the current value when it cannot run. */
export function modelOptions(list: ProviderList, hidden: ReadonlySet<string>, value: string): SelectOption[] {
  const options: SelectOption[] = choosable(list, hidden).map((o) => ({ value: o.value, label: o.label, group: o.group }));
  if (value && !canRun(list, value) && !options.some((o) => o.value === value))
    options.unshift({ value, label: `${chipLabel(value, list)} (not available)`, disabled: true });
  if (options.length === 0) options.push({ value: "", label: "Connect a provider first", disabled: true });
  return options;
}
