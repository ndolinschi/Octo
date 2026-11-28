import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type FocusEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { Draft } from "../../lib/schemaForm/draft";
import type { NormalForm, SchemaField } from "../../lib/schemaForm/schema";
import { widgetFor } from "../../lib/schemaForm/widgets";
import { Checkbox } from "../primitives/Checkbox";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { IconButton } from "../primitives/IconButton";
import { Segmented } from "../primitives/Segmented";
import { Select } from "../primitives/Select";
import { TextArea, TextField } from "../primitives/TextField";
import type { SchemaFormState } from "./useSchemaForm";

/**
 * The one renderer of schema forms (spec 2026-11-15 §A.4, UI decision 97): every control comes from the schema through
 * `widgetFor`, on primitives only; no form is written by hand. One column: label, description under it, the control, the
 * error under the control. Optional fields say "optional"; required ones carry `aria-required`. Titles and descriptions
 * are text, never markup. The form's live region says how many fields need attention after a failed submit.
 */
export function SchemaForm({ form, state, idPrefix }: { form: NormalForm; state: SchemaFormState; idPrefix?: string }) {
  const own = useId();
  const prefix = idPrefix ?? own;
  return (
    <div className="flex flex-col gap-4">
      {form.fields
        .filter((f) => state.shown.has(f.id))
        .map((f) => (
          <FieldView key={f.id} field={f} domId={`${prefix}-${f.id}`} state={state} />
        ))}
      <p aria-live="polite" className="sr-only">
        {state.announce}
      </p>
    </div>
  );
}

type ViewProps = { field: SchemaField; domId: string; state: SchemaFormState };

function FieldView({ field, domId, state }: ViewProps) {
  const widget = widgetFor(field);
  const error = state.errors[field.id];
  const descId = field.description ? `${domId}-desc` : undefined;
  const errorId = error ? `${domId}-error` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(" ") || undefined;
  const labelId = `${domId}-label`;
  const draft = state.drafts[field.id];
  const choices = field.choices ?? [];
  const unchosen = (widget === "segments" || widget === "choices") && !choices.some((c) => c.const === draft);
  // R2: a row of segments or choices with none picked says so in its label ("Region · choose one"), not beside the track.
  const label = unchosen ? `${field.title} · choose one` : field.title;
  const groupLabel = widget === "segments" || widget === "choices" || widget === "checkboxes";

  if (widget === "checkbox") {
    return (
      <div data-schema-field={field.id} className="flex flex-col gap-1">
        <Checkbox
          ref={state.registerControl(field.id)}
          id={domId}
          checked={draft === true}
          disabled={state.busy !== null}
          invalid={error !== undefined}
          label={field.title}
          description={field.description || undefined}
          onChange={(v) => state.setDraft(field.id, v)}
        />
        <FieldError id={errorId} text={error} />
      </div>
    );
  }

  return (
    <div data-schema-field={field.id} className="flex flex-col gap-1">
      <div className="flex flex-col gap-0.5">
        {groupLabel ? (
          <span id={labelId} className="flex items-baseline gap-1.5 text-sm text-fg-2">
            {label}
            {!field.required && <span className="text-xs text-fg-3">optional</span>}
          </span>
        ) : (
          <label id={labelId} htmlFor={domId} className="flex items-baseline gap-1.5 text-sm text-fg-2">
            {label}
            {!field.required && <span className="text-xs text-fg-3">optional</span>}
          </label>
        )}
        {field.description && (
          <p id={descId} className="max-w-[56ch] text-xs [overflow-wrap:anywhere] text-fg-3">
            {field.description}
          </p>
        )}
      </div>
      <Control
        field={field}
        widget={widget}
        domId={domId}
        labelId={labelId}
        label={field.title}
        describedBy={describedBy}
        invalid={error !== undefined}
        state={state}
      />
      <FieldError id={errorId} text={error} />
    </div>
  );
}

function FieldError({ id, text }: { id: string | undefined; text: string | undefined }): ReactNode {
  if (!text || !id) return null;
  return (
    <p id={id} className="text-xs text-err">
      {text}
    </p>
  );
}

type ControlProps = {
  field: SchemaField;
  widget: ReturnType<typeof widgetFor>;
  domId: string;
  labelId: string;
  label: string;
  describedBy: string | undefined;
  invalid: boolean;
  state: SchemaFormState;
};

function Control(props: ControlProps) {
  const { field, widget, domId, describedBy, invalid, state } = props;
  const p = field.prop;
  const disabled = state.busy !== null;
  const draft = state.drafts[field.id];
  const text = typeof draft === "string" ? draft : "";
  const set = (v: Draft) => state.setDraft(field.id, v);
  const choices = field.choices ?? [];
  const common = {
    id: domId,
    disabled,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
    onBlur: (e: FocusEvent<HTMLElement>) => state.blur(field.id, e.relatedTarget),
    placeholder: p["x-octo"]?.placeholder,
  };
  switch (widget) {
    case "password":
      return <SecretInput {...props} />;
    case "segments":
      return (
        <div
          ref={state.registerControl(field.id)}
          id={domId}
          role="group"
          tabIndex={-1}
          aria-labelledby={props.labelId}
          aria-describedby={describedBy}
          className="flex flex-wrap items-center"
        >
          <Segmented
            label={props.label}
            options={choices.map((c) => ({ id: c.const, label: c.title }))}
            value={text}
            disabled={disabled}
            onChange={(v) => !disabled && set(v)}
          />
        </div>
      );
    case "choices":
      return (
        <ChoiceGroup
          ref={state.registerControl(field.id)}
          id={domId}
          label={props.label}
          labelledBy={props.labelId}
          describedBy={describedBy}
          options={choices.map((c) => ({ id: c.const, label: c.title }))}
          value={text}
          disabled={disabled}
          invalid={invalid}
          required={field.required}
          onChange={(v) => !disabled && set(v)}
        />
      );
    case "select":
      return (
        <Select
          ref={state.registerControl(field.id)}
          id={domId}
          label={props.label}
          value={text}
          placeholder="Choose…"
          disabled={disabled}
          invalid={invalid}
          required={field.required}
          {...(describedBy ? { describedBy } : {})}
          options={choices.map((c) => ({ value: c.const, label: c.title }))}
          onChange={(v) => set(v)}
        />
      );
    case "checkboxes": {
      const chosen = Array.isArray(draft) ? draft : [];
      return (
        <div
          ref={state.registerControl(field.id)}
          id={domId}
          role="group"
          tabIndex={-1}
          aria-labelledby={props.labelId}
          aria-describedby={describedBy}
          className="flex flex-col gap-2"
        >
          {choices.map((c) => (
            <Checkbox
              key={c.const}
              checked={chosen.includes(c.const)}
              disabled={disabled}
              invalid={invalid}
              label={c.title}
              onChange={(on) => set(on ? choices.map((x) => x.const).filter((v) => v === c.const || chosen.includes(v)) : chosen.filter((v) => v !== c.const))}
            />
          ))}
        </div>
      );
    }
    case "textarea":
      return <TextArea ref={state.registerControl(field.id)} {...common} rows={3} value={text} onChange={(e) => set(e.target.value)} />;
    case "number": {
      const step = p.type === "number" || p.type === "integer" ? (p["x-octo"]?.step ?? (p.type === "integer" ? 1 : "any")) : undefined;
      return (
        <TextField
          ref={state.registerControl(field.id)}
          {...common}
          type="number"
          inputMode={p.type === "integer" ? "numeric" : "decimal"}
          step={step}
          min={p.type === "number" || p.type === "integer" ? p.minimum : undefined}
          max={p.type === "number" || p.type === "integer" ? p.maximum : undefined}
          value={text}
          className="max-w-40 tabular-nums"
          onChange={(e) => set(e.target.value)}
        />
      );
    }
    case "date":
    case "datetime":
      return (
        <TextField
          ref={state.registerControl(field.id)}
          {...common}
          type={widget === "date" ? "date" : "datetime-local"}
          value={text}
          className="max-w-60 tabular-nums"
          onChange={(e) => set(e.target.value)}
        />
      );
    default:
      return (
        <TextField
          ref={state.registerControl(field.id)}
          {...common}
          type={widget === "email" ? "email" : widget === "url" ? "url" : "text"}
          inputMode={widget === "email" ? "email" : widget === "url" ? "url" : undefined}
          autoComplete={widget === "email" ? "email" : "off"}
          spellCheck={widget === "text"}
          autoCapitalize={widget === "text" ? undefined : "off"}
          value={text}
          className={cn(widget === "path" && "font-mono")}
          onChange={(e) => set(e.target.value)}
        />
      );
  }
}

/**
 * A secret (decision 43): masked, uncontrolled (its value is never React state), no autocomplete or spellcheck, a reveal
 * toggle. The form reads it once at submit and empties it after a successful one.
 */
function SecretInput({ field, domId, describedBy, invalid, state }: ControlProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <TextField
        ref={state.registerControl(field.id)}
        id={domId}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-1p-ignore=""
        data-lpignore="true"
        disabled={state.busy !== null}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        placeholder={field.prop["x-octo"]?.placeholder}
        className="pr-10 font-mono"
        onInput={() => state.clearError(field.id)}
        onBlur={(e) => state.blur(field.id, e.relatedTarget)}
      />
      <IconButton
        icon={shown ? EyeOff : Eye}
        label={shown ? "Hide" : "Show"}
        pressed={shown}
        size="sm"
        className="absolute top-0.5 right-0.5 touch:top-1.5 touch:right-1.5"
        onClick={() => setShown((s) => !s)}
      />
    </div>
  );
}
