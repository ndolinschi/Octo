import type { ProviderList } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { canRun, chipLabel, choosable } from "../../lib/providers";
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
    description: "Small, quick tasks handed out to agents.",
    projectDescription: "Small, quick tasks handed out to agents.",
  },
  {
    id: SETTING_IDS.modelBalanced,
    field: "balanced",
    rowId: "tiers",
    title: "Balanced tier",
    description: "Most delegated work.",
    projectDescription: "Most delegated work.",
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

/** What a model select offers: every model a connected provider runs (grouped by provider), plus the current value when it cannot run. */
export function modelOptions(list: ProviderList, hidden: ReadonlySet<string>, value: string): SelectOption[] {
  const options: SelectOption[] = choosable(list, hidden).map((o) => ({ value: o.value, label: o.label, group: o.group }));
  if (value && !canRun(list, value) && !options.some((o) => o.value === value))
    options.unshift({ value, label: `${chipLabel(value, list)} (not available)`, disabled: true });
  if (options.length === 0) options.push({ value: "", label: "Connect a provider first", disabled: true });
  return options;
}
