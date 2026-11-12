import { useState } from "react";
import { CONTROL_SIZES } from "../../../lib/controls";
import { Checkbox } from "../Checkbox";
import { Field } from "../Field";
import { KeyHint } from "../KeyHint";
import { SearchField } from "../SearchField";
import { Select } from "../Select";
import { Switch } from "../Switch";
import { TextArea, TextField } from "../TextField";
import { Section, Variants, W } from "./parts";

const OPTIONS = [
  { value: "fast", label: "Fast", description: "Haiku-class, cheap" },
  { value: "balanced", label: "Balanced" },
  { value: "deep", label: "Deep" },
  { value: "off", label: "Off", disabled: true },
];

export function FieldsSection() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [pick, setPick] = useState("balanced");
  const [q, setQ] = useState("");
  const [q2, setQ2] = useState("memory");
  return (
    <Section id="fields" title="Fields" note="One focus indicator for every field: the border turns fg and the shadow ring is off. Click into each to see it.">
      <Variants label="TextField sizes (framed), invalid, disabled, bare">
        {CONTROL_SIZES.map((s) => (
          <W key={s} w="w-36">
            <TextField size={s} placeholder={`size ${s}`} aria-label={`size ${s}`} />
          </W>
        ))}
        <W w="w-36">
          <TextField aria-label="invalid" aria-invalid defaultValue="bad value" />
        </W>
        <W w="w-36">
          <TextField aria-label="disabled" disabled placeholder="disabled" />
        </W>
        <span className="rounded-md border border-line px-2">
          <TextField variant="bare" aria-label="bare" placeholder="bare in a frame" className="w-36" />
        </span>
      </Variants>
      <Variants label="Field + TextArea">
        <Field label="Name" hint="Shown in the sidebar." className="w-64">
          <TextField placeholder="My project" />
        </Field>
        <Field label="Notes" optional error="Too long." className="w-64">
          <TextArea rows={2} aria-invalid defaultValue="Some text" />
        </Field>
      </Variants>
      <Variants label="SearchField: bordered (sizes), with shortcut, with text and clear, header, bare">
        <SearchField value={q} onChange={setQ} label="Search" size="sm" className="w-48" />
        <SearchField value={q} onChange={setQ} label="Search" className="w-48" shortcut={<KeyHint>/</KeyHint>} />
        <SearchField value={q2} onChange={setQ2} label="Search" size="lg" className="w-48" />
        <SearchField value={q} onChange={setQ} label="Filter" variant="header" className="w-64 rounded-md border border-line" />
        <SearchField value={q} onChange={setQ} label="Ask a side question" variant="bare" className="w-48" />
      </Variants>
      <Variants label="Select (menu-based): sizes, bottom-opening, top-opening, placeholder, invalid, disabled">
        <W>
          <Select value={pick} onChange={setPick} options={OPTIONS} label="Tier" size="sm" />
        </W>
        <W>
          <Select value={pick} onChange={setPick} options={OPTIONS} label="Tier" />
        </W>
        <W>
          <Select value={pick} onChange={setPick} options={OPTIONS} label="Tier (opens up)" side="top" />
        </W>
        <W>
          <Select value="" onChange={setPick} options={OPTIONS} label="Tier" placeholder="Choose…" />
        </W>
        <W>
          <Select value={pick} onChange={setPick} options={OPTIONS} label="Tier" invalid />
        </W>
        <W>
          <Select value={pick} onChange={setPick} options={OPTIONS} label="Tier" disabled />
        </W>
      </Variants>
      <Variants label="Checkbox: off, on, indeterminate, description, disabled; Switch: on, off, disabled">
        <Checkbox checked={false} onChange={() => undefined} label="Off" />
        <Checkbox checked={checked} onChange={setChecked} label="On" />
        <Checkbox checked={false} indeterminate onChange={() => undefined} label="Some" />
        <Checkbox checked={checked} onChange={setChecked} label="With text" description="A dim explanation line." />
        <Checkbox checked disabled onChange={() => undefined} label="Disabled" />
        <Switch checked={on} onChange={setOn} label="On" />
        <Switch checked={!on} onChange={() => setOn(!on)} label="Off" />
        <Switch checked disabled onChange={() => undefined} label="Disabled" />
      </Variants>
    </Section>
  );
}
