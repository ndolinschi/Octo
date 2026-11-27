import type { ProviderList } from "@octo/agent-client";
import { useMemo, useState } from "react";
import { choosable, useHiddenModels } from "../../lib/providers";
import { SearchField } from "../primitives/SearchField";
import { Switch } from "../primitives/Switch";
import { SettingsGroup, SettingsRow } from "./parts";

/** "Which models appear in menus": every model a connected provider runs, each with a switch; searchable. A machine setting. */
export function VisibleModels({ list }: { list: ProviderList }) {
  const [hidden, setHidden] = useHiddenModels();
  const [query, setQuery] = useState("");
  const all = useMemo(() => choosable(list).filter((o) => o.value.includes("/") || !o.value.startsWith("acp:")), [list]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((o) => words.every((w) => `${o.group} ${o.label} ${o.value}`.toLowerCase().includes(w)));
  const hiddenSet = new Set(hidden);
  return (
    <SettingsGroup label="Models in menus" id="row-visible" footer="Hidden models stay usable by projects that already chose them.">
      {/* The search is the list's first row (a 40px band on the rows' text edge), not a field hung on the caption line. */}
      <div className="flex h-ctl-lg items-center px-settings-inset">
        <SearchField variant="bare" label="Search models" value={query} onChange={setQuery} className="h-full flex-1" />
      </div>
      {all.length === 0 && <SettingsRow title="No models yet" description="Connect a provider: its models appear here." />}
      {all.length > 0 && shown.length === 0 && (
        <SettingsRow title="No model matches" description={`Nothing matches “${query.trim()}”. Clear the search to see all ${all.length}.`} />
      )}
      {shown.map((o) => (
        <SettingsRow
          key={o.value}
          // The provider once, under the name ("Claude Code · Sonnet 5.5" over "Claude Code" said it twice; with accounts the
          // label reads "Claude Code · Work / Sonnet 5.5" over "Claude Code · Work").
          title={[" · ", " / "].map((sep) => `${o.group}${sep}`).find((p) => o.label.startsWith(p)) ? o.label.slice(o.group.length + 3) : o.label}
          description={o.group}
          control={
            <Switch
              label={`Show ${o.label} in menus`}
              checked={!hiddenSet.has(o.value)}
              onChange={(on) => setHidden((h) => (on ? h.filter((x) => x !== o.value) : [...h, o.value]))}
            />
          }
        />
      ))}
    </SettingsGroup>
  );
}
