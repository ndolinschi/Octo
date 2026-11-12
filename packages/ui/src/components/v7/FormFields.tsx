import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { InputField } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { IconButton } from "../primitives/IconButton";
import { Checkbox } from "../primitives/Checkbox";
import { Field } from "../primitives/Field";
import { Segmented } from "../primitives/Segmented";
import { Select } from "../primitives/Select";
import { TextField } from "../primitives/TextField";

/** Selects with at most this many options are a row of choices; longer ones a native select. */
const CHOICES_MAX = 4;

type Props = {
  field: InputField;
  domId: string;
  value: string | boolean | undefined;
  error: string | undefined;
  disabled: boolean;
  registerControl(el: HTMLElement | null): void;
  onChange(value: string | boolean): void;
  /** A secret was typed in (its value stays in the input): clears the field's error. */
  onSecretInput(): void;
};

/** One field of a form card: label above, the control, help and the error under it (decision 43). */
export function FormField(props: Props) {
  const { field, domId, error } = props;
  const errorId = `${domId}-error`;
  const described = error ? errorId : undefined;
  if (field.kind === "confirm") {
    return (
      <div ref={(el) => props.registerControl(el)} tabIndex={-1} id={domId} className="flex flex-col gap-1.5">
        <Checkbox checked={props.value === true} disabled={props.disabled} label={field.label} onChange={(v) => props.onChange(v)} />
        {field.help && <p className="text-xs text-fg-3">{field.help}</p>}
        {error && (
          <p id={errorId} className="text-xs text-err">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <Field label={field.label} htmlFor={domId} hint={field.help} error={error ?? null} errorId={errorId} optional={!field.required}>
      <Control {...props} described={described} />
    </Field>
  );
}

function Control(props: Props & { described: string | undefined }) {
  const { field, domId, error, described } = props;
  const value = typeof props.value === "string" ? props.value : "";
  switch (field.kind) {
    case "secret":
      return <SecretInput {...props} />;
    case "select": {
      const options = field.options ?? [];
      if (options.length <= CHOICES_MAX) {
        return (
          <div ref={(el) => props.registerControl(el)} id={domId} tabIndex={-1} aria-describedby={described} aria-invalid={error ? true : undefined}>
            <Segmented
              label={field.label}
              options={options.map((o) => ({ id: o, label: o }))}
              value={value}
              onChange={(v) => !props.disabled && props.onChange(v)}
            />
          </div>
        );
      }
      return (
        <div ref={(el) => props.registerControl(el)} tabIndex={-1}>
          <Select
            id={domId}
            label={field.label}
            value={value}
            placeholder="Choose…"
            disabled={props.disabled}
            invalid={error !== undefined}
            options={options.map((o) => ({ value: o, label: o }))}
            onChange={props.onChange}
          />
        </div>
      );
    }
    case "text":
    case "path":
      return (
        <TextField
          ref={(el) => props.registerControl(el)}
          id={domId}
          value={value}
          disabled={props.disabled}
          spellCheck={field.kind === "text"}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          aria-required={field.required}
          className={cn(field.kind === "path" && "font-mono")}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    default:
      return null;
  }
}

/**
 * A secret: masked, uncontrolled (its value is never React state), no autocomplete or spellcheck, a reveal toggle
 * (decision 43). The form reads it once at submit and empties it after a successful one.
 */
function SecretInput(props: Props & { described: string | undefined }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <TextField
        ref={(el) => props.registerControl(el)}
        id={props.domId}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-1p-ignore=""
        data-lpignore="true"
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.described}
        aria-required={props.field.required}
        className="pr-10 font-mono"
        onInput={props.onSecretInput}
      />
      <IconButton
        icon={shown ? EyeOff : Eye}
        label={shown ? "Hide" : "Show"}
        pressed={shown}
        size="sm"
        className="absolute top-1 right-1"
        onClick={() => setShown((s) => !s)}
      />
    </div>
  );
}
