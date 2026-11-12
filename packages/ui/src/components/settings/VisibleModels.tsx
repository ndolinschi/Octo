import type { ProviderList } from "@octo/agent-client";
import { useMemo, useState } from "react";
import { choosable, useHiddenModels } from "../../lib/providers";
import { SearchField } from "../primitives/SearchField";
import { Switch } from "../primitives/Switch";
import { CONTROL_W, SettingsGroup, SettingsRow } from "./parts";

/** "Which models appear in pickers": every model a connected provider runs, each with a switch; searchable. A machine setting. */
export function VisibleModels({ list }: { list: ProviderList }) {
  const [hidden, setHidden] = useHiddenModels();
  const [query, setQuery] = useState("");
  const all = useMemo(() => choosable(list).filter((o) => o.value.includes("/") || !o.value.startsWith("acp:")), [list]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((o) => words.every((w) => `${o.group} ${o.label} ${o.value}`.toLowerCase().includes(w)));
  const hiddenSet = new Set(hidden);
  return (
    <SettingsGroup
      label="Models in pickers"
      id="row-visible"
      footer="Hidden models stay usable by projects that already chose them."
      aside={<SearchField label="Search models" value={query} onChange={setQuery} className={CONTROL_W.lg} />}
    >
      {all.length === 0 && <SettingsRow title="No models yet" description="Connect a provider: its models appear here." />}
      {all.length > 0 && shown.length === 0 && (
        <SettingsRow title="No model matches" description={`Nothing matches “${query.trim()}”. Clear the search to see all ${all.length}.`} />
      )}
      {shown.map((o) => (
        <SettingsRow
          key={o.value}
          title={o.label}
          description={o.group}
          control={
            <Switch
              label={`Show ${o.label} in pickers`}
              checked={!hiddenSet.has(o.value)}
              onChange={(on) => setHidden((h) => (on ? h.filter((x) => x !== o.value) : [...h, o.value]))}
            />
          }
        />
      ))}
    </SettingsGroup>
  );
}
