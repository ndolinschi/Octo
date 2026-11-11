import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { InputField } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { IconButton } from "../primitives/Button";
import { Field, Input } from "../primitives/Field";

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
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-7 items-start gap-2 text-sm text-fg max-md:min-h-10 max-md:items-center">
          <input
            ref={(el) => props.registerControl(el)}
            id={domId}
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-[var(--octo-primary)] max-md:mt-0"
            checked={props.value === true}
            disabled={props.disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={described}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
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
  const touch = "max-md:h-10 max-md:text-input-touch";
  switch (field.kind) {
    case "secret":
      return <SecretInput {...props} />;
    case "select": {
      const options = field.options ?? [];
      if (options.length <= CHOICES_MAX) {
        return (
          <div
            ref={(el) => props.registerControl(el)}
            id={domId}
            role="radiogroup"
            aria-describedby={described}
            aria-invalid={error ? true : undefined}
            className="flex flex-wrap gap-2"
            tabIndex={-1}
          >
            {options.map((o) => (
              <label
                key={o}
                className={cn(
                  "inline-flex h-7 min-w-0 press items-center rounded-sm border px-3 text-sm has-focus-visible:shadow-[0_0_0_2px_var(--octo-focus)] max-md:h-10",
                  value === o ? "border-fg bg-active text-fg" : "border-line-strong text-fg-2 hover:bg-hover",
                  error && value !== o && "border-err/60",
                )}
              >
                <input
                  type="radio"
                  name={domId}
                  value={o}
                  checked={value === o}
                  disabled={props.disabled}
                  className="sr-only"
                  onChange={() => props.onChange(o)}
                />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
        );
      }
      return (
        <select
          ref={(el) => props.registerControl(el)}
          id={domId}
          value={value}
          disabled={props.disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(e) => props.onChange(e.target.value)}
          className={cn(
            "h-8 w-full rounded-md border border-input-border bg-panel px-2 text-sm text-fg focus:border-fg focus:outline-none aria-invalid:border-err",
            touch,
          )}
        >
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    case "text":
    case "path":
      return (
        <Input
          ref={(el) => props.registerControl(el)}
          id={domId}
          value={value}
          disabled={props.disabled}
          spellCheck={field.kind === "text"}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          aria-required={field.required}
          className={cn(field.kind === "path" && "font-mono", touch)}
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
      <Input
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
        className="pr-10 font-mono max-md:h-10 max-md:text-input-touch"
        onInput={props.onSecretInput}
      />
      <IconButton
        icon={shown ? EyeOff : Eye}
        label={shown ? "Hide" : "Show"}
        pressed={shown}
        size="sm"
        className="absolute top-1 right-1 max-md:top-2 max-md:right-2"
        onClick={() => setShown((s) => !s)}
      />
    </div>
  );
}
