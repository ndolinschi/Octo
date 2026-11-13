import type { Provider, ProviderRoles } from "@octo/agent-client";
import { useEffect, useId, useRef, useState } from "react";
import { cleanModelName, customModelsCodec, preferredModel, roleModel, selectOptions, useAgentPrefs } from "../../lib/providers";
import { PREFS, usePersistentState } from "../../lib/storage";
import { useApp } from "../../state/app";
import { FieldRow } from "../primitives/FieldRow";
import { Select } from "../primitives/Select";
import { TextField } from "../primitives/TextField";
import { SaveStatus } from "./parts";
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
  // S2: each group says "Saved" at its caption's right, so a save never adds a line under the fields.
  const [preferredState, runPreferred] = useSave();
  const [state, run] = useSave();
  const base = useId();
  const control = (key: string, value: string, label: string, onSave: (m: string) => Promise<void>, go = run) => (
    <ModelControl id={`${base}-${key}`} label={label} agent={agent} value={value} typed={typed} onSave={(m) => void go(() => onSave(m))} />
  );
  return (
    <>
      <section className="flex flex-col gap-1">
        <SectionTitle aside={<SaveStatus state={preferredState} />}>Preferred model</SectionTitle>
        <FieldRow
          fields={[
            {
              id: `${base}-preferred`,
              label: "Model",
              control: control("preferred", preferredModel(agent, local), "Preferred model", (m) => save(agent.id, { preferred_model: m }), runPreferred),
            },
          ]}
          hint="Used whenever this provider is chosen."
        />
      </section>
      <section className="flex flex-col gap-1">
        <SectionTitle aside={<SaveStatus state={state} />}>Roles</SectionTitle>
        <FieldRow
          fields={ROLES.map((r) => ({
            id: `${base}-${r.id}`,
            label: r.label,
            control: control(r.id, roleModel(agent, r.id, local), r.label, (m) => save(agent.id, { roles: { [r.id]: m } })),
          }))}
          hint="The router decides how hard a task is; roles say which of this provider's models does it."
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
      <TextField
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
      />
    );
  return (
    <Select
      id={props.id}
      label={props.label}
      value={props.value}
      options={[
        { value: DEFAULT, label: "Default" },
        ...options.map((o) => ({ value: o.id, label: o.label })),
        ...(props.agent.accepts_custom_model !== false ? [{ value: OTHER, label: "Other…" }] : []),
      ]}
      onChange={(value) => {
        if (value === OTHER) {
          setDraft("");
          setOther(true);
          return;
        }
        props.onSave(value);
      }}
    />
  );
}
