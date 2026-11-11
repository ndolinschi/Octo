import type { ProviderList } from "@octo/agent-client";
import { SETTING_IDS } from "@octo/agent-client";
import { Search } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { canRun, chipLabel, choosable, useHiddenModels, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { useHarnessSettings } from "./harnessSettings";
import { useSettingsActions } from "./pageContext";
import { SaveStatus, Select, SettingsGroup, SettingsRow, SkeletonRow, Switch } from "./parts";
import { useSave } from "./useSave";

const DEFAULTS = [
  {
    id: SETTING_IDS.modelOrchestrator,
    rowId: "default-orchestrator",
    title: "Default orchestrator",
    description: "Runs the orchestrator of projects created from now on.",
  },
  { id: SETTING_IDS.modelFast, rowId: "tier-fast", title: "Fast tier", description: "Small, quick tasks the orchestrator hands out." },
  { id: SETTING_IDS.modelBalanced, rowId: "tiers", title: "Balanced tier", description: "Most delegated work." },
  { id: SETTING_IDS.modelDeep, rowId: "tier-deep", title: "Deep tier", description: "Hard problems that need the strongest model." },
] as const;

/** Decision 59 Models: defaults for new projects (only what can run, decision 53 a) and which models pickers show. */
export function ModelsSection() {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const harness = useHarnessSettings();
  const list = providers.status === "ready" ? providers.list : null;
  return (
    <>
      <SettingsGroup label="Defaults for new projects" footer="A project keeps its own models; change them in its settings.">
        {(providers.status === "loading" || harness.load.status === "loading") && DEFAULTS.map((d) => <SkeletonRow key={d.id} />)}
        {harness.load.status === "unavailable" && (
          <SettingsRow title="Not available here" description="This connection cannot change the harness's default models." />
        )}
        {harness.load.status === "error" && (
          <SettingsRow
            title={<span className="text-err">Couldn't load settings</span>}
            description={`${harness.load.message}. Retry once the harness is running.`}
            control={
              <Button size="sm" onClick={harness.reload}>
                Retry
              </Button>
            }
          />
        )}
        {providers.status === "error" && (
          <SettingsRow
            title={<span className="text-err">Couldn't load providers</span>}
            description={`${providers.message.replace(/\.$/, "")}. Retry once the harness is running.`}
            control={
              <Button size="sm" onClick={() => void providers.refresh()}>
                Retry
              </Button>
            }
          />
        )}
        {list && harness.load.status === "ready" && DEFAULTS.map((d) => <DefaultModelRow key={d.id} def={d} list={list} />)}
      </SettingsGroup>
      {list && <VisibleModels list={list} />}
    </>
  );
}

function DefaultModelRow({ def, list }: { def: (typeof DEFAULTS)[number]; list: ProviderList }) {
  const harness = useHarnessSettings();
  const { connect } = useSettingsActions();
  const [saved, run] = useSave();
  const [hidden] = useHiddenModels();
  const id = useId();
  const s = harness.get(def.id);
  const options = useMemo(() => choosable(list, new Set(hidden)), [list, hidden]);
  if (!s) return null;
  const value = typeof s.value === "string" ? s.value : "";
  const runs = !value || canRun(list, value);
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <SettingsRow
      rowId={def.rowId}
      title={def.title}
      htmlFor={id}
      description={s.editable ? def.description : (s.note ?? `Set by the ${s.source}.`)}
      status={
        !runs ? (
          <p role="status" className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-warn">
            {chipLabel(value, list)} cannot run: its provider is not connected.
            <button type="button" className="rounded-xs text-link underline-offset-2 hover:underline" onClick={() => connect("providers")}>
              Connect a provider
            </button>
          </p>
        ) : (
          <SaveStatus state={saved} />
        )
      }
      control={
        <Select
          id={id}
          value={value}
          disabled={!s.editable || options.length === 0}
          onChange={(e) => void run(() => harness.save({ set: { [def.id]: e.target.value } }))}
          className="w-64"
        >
          {!runs && <option value={value}>{chipLabel(value, list)} (not available)</option>}
          {options.length === 0 && <option value="">Connect a provider first</option>}
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {options
                .filter((o) => o.group === g)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      }
    />
  );
}

/** "Which models appear in pickers": every model a connected provider runs, each with a switch; searchable. */
function VisibleModels({ list }: { list: ProviderList }) {
  const [hidden, setHidden] = useHiddenModels();
  const [query, setQuery] = useState("");
  const all = useMemo(() => choosable(list).filter((o) => o.value.includes("/") || !o.value.startsWith("acp:")), [list]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((o) => words.every((w) => `${o.group} ${o.label} ${o.value}`.toLowerCase().includes(w)));
  const hiddenSet = new Set(hidden);
  const searchId = useId();
  return (
    <section className="flex flex-col gap-2" id="row-visible">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 px-1">
        <h2 className="flex-1 text-xs text-fg-3">Models in pickers</h2>
        <label
          htmlFor={searchId}
          className="flex h-8 w-64 items-center gap-2 rounded-md border border-input-border bg-panel px-3 text-fg-3 focus-within:border-fg max-settings:w-full"
        >
          <Glyph icon={Search} size={14} className="shrink-0" />
          <span className="sr-only">Search models</span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
          />
        </label>
      </div>
      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">
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
      </div>
      <p className="px-1 text-xs text-fg-3">Hidden models stay usable by projects that already chose them.</p>
    </section>
  );
}
