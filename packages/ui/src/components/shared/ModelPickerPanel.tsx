import type { PluginAgent, TierPolicy } from "@octo/agent-client";
import { Cpu, Layers } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { TIER_POLICIES } from "../../lib/models";
import { choiceKey, favouritesFrom, modelChoices, toggleFavourite, withFavourites, type ModelChoice } from "../../lib/modelPicker";
import { filterSections, type PickerRow, type PickerSection } from "../../lib/picker";
import { jsonCodec, PREFS, usePersistentState } from "../../lib/storage";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Picker } from "../primitives/Picker";
import { Segmented } from "../primitives/Segmented";
import type { ModelPickerProps } from "./modelPickerProps";

const favouritesCodec = jsonCodec(favouritesFrom);
const NO_AGENTS: PluginAgent[] = [];

/** The plugins' agents (login state and hint), read once per picker; without them every agent counts as logged in. */
function usePluginAgents(): PluginAgent[] {
  const activity = useActivity();
  const [agents, setAgents] = useState<PluginAgent[]>(NO_AGENTS);
  useEffect(() => {
    let alive = true;
    activity.plugins().then(
      (p) => alive && setAgents(p.flatMap((x) => x.agents)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [activity]);
  return agents;
}

/** The model picker's list (decision 27), loaded with the first open (its own chunk): see `ModelPicker`. */
export function ModelPickerPanel(props: ModelPickerProps & { anchor: RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const { config } = useApp();
  const [favourites, setFavourites] = usePersistentState(PREFS.favouriteModels, favouritesCodec, { persistInitial: false });
  const agents = usePluginAgents();
  const acp = config?.acp_orchestrators ?? [];
  const variant = props.variant ?? "bar";
  const button = props.anchor;
  const toRow = (c: ModelChoice, section: string): PickerRow => {
    const on = favourites.includes(c.value);
    return {
      id: `${section}:${choiceKey(c)}`,
      label: c.label,
      ...(c.detail ? { detail: c.detail } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
      title: c.title ?? c.value,
      ...(c.disabled ? { disabled: true } : {}),
      // A tier and its model write the same value: the model row carries the mark.
      checked: c.value === props.value && c.section !== "Tiers",
      lead: <Glyph icon={c.section === "Agents" ? GLYPH.agent : c.section === "Tiers" ? Layers : Cpu} size={14} />,
      ...(c.section === "Tiers" ? {} : { star: { on, toggle: () => setFavourites((f) => toggleFavourite(f, c.value)) } }),
      run: () => props.onChoose(c.value),
    };
  };

  const sections = (query: string): PickerSection[] => {
    const choices = modelChoices({ ...(props.tiers ? { tiers: props.tiers } : {}), known: props.known, acp, agents });
    const { favourites: fav, rest } = withFavourites(choices, favourites);
    const by = (s: ModelChoice["section"]) => rest.filter((c) => c.section === s).map((c) => toRow(c, s));
    const typed = query.trim();
    const customRow: PickerRow[] =
      props.custom && typed && !/\s/.test(typed) && !choices.some((c) => c.value === typed)
        ? [{ id: `custom:${typed}`, label: `Use “${typed}”`, detail: "model id", lead: <Glyph icon={Cpu} size={14} />, run: () => props.onChoose(typed) }]
        : [];
    return [
      ...(customRow.length ? [{ title: "Custom", rows: customRow }] : []),
      ...filterSections(
        [
          { title: "Favourites", rows: fav.map((c) => toRow(c, "Favourites")) },
          { title: "Tiers", rows: by("Tiers") },
          { title: "Models", rows: by("Models") },
          { title: "Agents", rows: by("Agents") },
        ],
        query,
      ),
    ];
  };

  const policy = config?.router ? props.policy : null;
  return (
    <Picker
      anchor={button}
      label={props.label}
      placeholder="Search models and agents"
      side={variant === "bar" ? "top" : "bottom"}
      align={variant === "text" ? "end" : "start"}
      digits
      {...(variant === "bar" ? { gap: 4 } : {})}
      sections={sections}
      onClose={props.onClose}
      footer={
        policy ? (
          <div className="flex h-row items-center gap-2 px-2 text-xs text-fg-3">
            <span className="min-w-0 flex-1 truncate">Routing</span>
            <Segmented<TierPolicy>
              label="Routing policy"
              value={policy.value}
              onChange={policy.onChange}
              options={TIER_POLICIES.map((p) => ({ id: p.value, label: p.label, title: p.detail }))}
            />
          </div>
        ) : undefined
      }
    />
  );
}
