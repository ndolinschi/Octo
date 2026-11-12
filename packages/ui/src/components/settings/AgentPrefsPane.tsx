import type { Provider, ProviderRoles } from "@octo/agent-client";
import { useEffect, useId, useRef, useState } from "react";
import { cleanModelName, customModelsCodec, preferredModel, roleModel, selectOptions, useAgentPrefs } from "../../lib/providers";
import { PREFS, usePersistentState } from "../../lib/storage";
import { useApp } from "../../state/app";
import { FieldRow } from "../primitives/FieldRow";
import { Input } from "../primitives/Field";
import { SaveStatus, Select } from "./parts";
import { SectionTitle } from "./ProviderParts";
import { useSave } from "./useSave";

const ROLES: { id: keyof ProviderRoles; label: string }[] = [
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "deep", label: "Deep" },
];
const DEFAULT = "";
const OTHER = "__other__";

/**
 * Decisions 72 b-c and 89 d: an agent's preferred model, and the model for each delegation role as one FieldRow
 * (Fast · Balanced · Deep side by side, stacked when the pane is narrow) with the explanation under the whole row.
 */
export function AgentPrefs({ agent }: { agent: Provider }) {
  const { bridge } = useApp();
  const { local, save } = useAgentPrefs(bridge);
  const [typed] = usePersistentState(PREFS.customModels, customModelsCodec, { persistInitial: false });
  const [state, run] = useSave();
  const base = useId();
  const control = (key: string, value: string, label: string, onSave: (m: string) => Promise<void>) => (
    <ModelControl id={`${base}-${key}`} label={label} agent={agent} value={value} typed={typed} onSave={(m) => void run(() => onSave(m))} />
  );
  return (
    <>
      <section className="flex flex-col gap-3">
        <SectionTitle>Preferred model</SectionTitle>
        <FieldRow
          fields={[
            {
              id: `${base}-preferred`,
              label: "Used when this provider is chosen",
              control: control("preferred", preferredModel(agent, local), "Preferred model", (m) => save(agent.id, { preferred_model: m })),
            },
          ]}
        />
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle>Roles</SectionTitle>
        <FieldRow
          fields={ROLES.map((r) => ({
            id: `${base}-${r.id}`,
            label: r.label,
            control: control(r.id, roleModel(agent, r.id, local), r.label, (m) => save(agent.id, { roles: { [r.id]: m } })),
          }))}
          hint="The router decides how hard a task is; roles say which of this provider's models does it."
          status={<SaveStatus state={state} />}
        />
      </section>
    </>
  );
}

/** A select over the agent's models plus "Default" and "Other…"; "Other…" swaps the select for a field of the same height. */
function ModelControl(props: {
  id: string;
  label: string;
  agent: Provider;
  value: string;
  typed: Readonly<Record<string, readonly string[]>>;
  onSave(model: string): void;
}) {
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (other) field.current?.focus();
  }, [other]);
  const options = selectOptions(props.agent, props.value, props.typed);
  const commit = () => {
    const name = cleanModelName(draft);
    setOther(false);
    if (name && name !== props.value) props.onSave(name);
  };
  if (other)
    return (
      <Input
        ref={field}
        id={props.id}
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
    );
  return (
    <Select
      id={props.id}
      value={props.value}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setDraft("");
          setOther(true);
          return;
        }
        props.onSave(e.target.value);
      }}
      className="w-full"
    >
      <option value={DEFAULT}>Default</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      {props.agent.accepts_custom_model !== false && <option value={OTHER}>Other…</option>}
    </Select>
  );
}
