import type { Provider, ProviderRoles } from "@octo/agent-client";
import { RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cleanModelName, customModelsCodec, preferredModel, refreshProviders, roleModel, selectOptions, useAgentPrefs } from "../../lib/providers";
import { PREFS, usePersistentState } from "../../lib/storage";
import { useApp } from "../../state/app";
import { Input } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { ProviderMark } from "../primitives/ProviderMark";
import { Spinner } from "../primitives/Status";
import { SaveStatus, Select } from "./parts";
import { useSave } from "./useSave";

const ROLES: { id: keyof ProviderRoles; label: string }[] = [
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "deep", label: "Deep" },
];
const DEFAULT = "";
const OTHER = "__other__";

/**
 * Decision 72 b-c: what Settings → Providers shows on the right of a selected agent: its preferred model and the model
 * for each delegation role (fast / balanced / deep). Each is a select over the agent's models plus "Default" and "Other…".
 */
export function AgentPrefsPane({ agent }: { agent: Provider }) {
  const { bridge } = useApp();
  const { local, save } = useAgentPrefs(bridge);
  const [typed] = usePersistentState(PREFS.customModels, customModelsCodec, { persistInitial: false });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (!bridge.refreshProviderModels || refreshing) return;
    setRefreshing(true);
    try {
      await bridge.refreshProviderModels(agent.id);
      await refreshProviders(bridge);
    } catch {
      // The list keeps what it had; the picker's refresh shows the reason.
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <aside aria-label={`${agent.label} models`} className="flex flex-col gap-4 rounded-lg border border-panel-edge bg-panel p-4 shadow-panel">
      <div className="flex items-center gap-2">
        <ProviderMark id={agent.id} label={agent.label} className="text-fg-3" />
        <h3 className="min-w-0 flex-1 truncate text-base text-fg">{agent.label}</h3>
        {bridge.refreshProviderModels && (
          <button
            type="button"
            onClick={() => void refresh()}
            aria-busy={refreshing}
            className="flex h-row shrink-0 press items-center gap-1.5 rounded-sm px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg"
          >
            {refreshing ? <Spinner /> : <Glyph icon={RefreshCw} size={14} />}
            Refresh models
          </button>
        )}
      </div>
      <ModelSelect
        key={`preferred-${agent.id}`}
        label="Preferred model"
        agent={agent}
        value={preferredModel(agent, local)}
        typed={typed}
        onSave={(m) => save(agent.id, { preferred_model: m })}
      />
      <div className="flex flex-col gap-3">
        <h4 className="text-xs text-fg-3">Roles</h4>
        {ROLES.map((r) => (
          <ModelSelect
            key={`${r.id}-${agent.id}`}
            label={r.label}
            agent={agent}
            value={roleModel(agent, r.id, local)}
            typed={typed}
            onSave={(m) => save(agent.id, { roles: { [r.id]: m } })}
          />
        ))}
      </div>
      <p className="text-xs text-fg-3">The router decides how hard a task is; roles say which of this provider&apos;s models does it.</p>
    </aside>
  );
}

function ModelSelect(props: {
  label: string;
  agent: Provider;
  value: string;
  typed: Readonly<Record<string, readonly string[]>>;
  onSave(model: string): Promise<void>;
}) {
  const id = useId();
  const [state, run] = useSave();
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (other) field.current?.focus();
  }, [other]);
  const options = selectOptions(props.agent, props.value, props.typed);
  const accepts = props.agent.accepts_custom_model !== false;
  const commit = () => {
    const name = cleanModelName(draft);
    setOther(false);
    if (name && name !== props.value) void run(() => props.onSave(name));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-fg-2">
        {props.label}
      </label>
      <div className="flex">
        <Select
          id={id}
          value={other ? OTHER : props.value}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setDraft("");
              setOther(true);
              return;
            }
            setOther(false);
            void run(() => props.onSave(e.target.value));
          }}
          className="w-full"
        >
          <option value={DEFAULT}>Default</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {accepts && <option value={OTHER}>Other…</option>}
        </Select>
      </div>
      {other && (
        <Input
          ref={field}
          aria-label={`Model name for ${props.label}`}
          placeholder={`e.g. ${options[0]?.id ?? "opus"}`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.preventDefault();
              setOther(false);
            }
          }}
          className="max-sm:text-input-touch"
        />
      )}
      <SaveStatus state={state} />
    </div>
  );
}
