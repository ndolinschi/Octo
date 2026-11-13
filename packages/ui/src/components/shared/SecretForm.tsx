import { useId, useRef, useState, type SyntheticEvent } from "react";
import { errorMessage } from "../../lib/format";
import { Button } from "../primitives/Button";
import { Field, Input } from "../primitives/Field";

/**
 * A write-only key field (decision 53 b). The value lives only in the DOM input: it is read on submit, handed to
 * `onSave` (which sends it to the harness through `putSettings`), and the field is cleared — it is never React state,
 * never rendered back and never logged.
 */
export function SecretForm(props: {
  label: string;
  set: boolean;
  hint?: string | undefined;
  placeholder: string;
  onSave(value: string): Promise<void>;
  focusFirst?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({ kind: "idle" });
  const id = useId();
  const errId = useId();
  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const el = input.current;
    const value = el?.value.trim() ?? "";
    if (!el || !value) {
      setStatus({ kind: "error", message: "Paste the key first." });
      el?.focus();
      return;
    }
    setStatus({ kind: "saving" });
    try {
      await props.onSave(value);
      el.value = "";
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: `${errorMessage(err).replace(/\.$/, "")}. Check the key and try again.` });
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2" autoComplete="off">
      <Field
        label={props.label}
        htmlFor={id}
        hint={
          props.set
            ? `A key is set${props.hint ? ` (${props.hint})` : ""}. A new one replaces it.`
            : "Stored by the harness in its settings file on this machine; never shown again."
        }
        error={status.kind === "error" ? status.message : null}
        errorId={errId}
      >
        <div className="flex gap-2 max-[420px]:flex-col">
          <Input
            ref={input}
            id={id}
            type="password"
            name="octo-provider-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={props.placeholder}
            aria-invalid={status.kind === "error" || undefined}
            aria-describedby={status.kind === "error" ? errId : undefined}
            data-autofocus={props.focusFirst || undefined}
            className="min-w-0 flex-1 font-mono text-xs max-sm:text-input-touch"
          />
          <Button type="submit" variant="primary" disabled={status.kind === "saving"} aria-busy={status.kind === "saving"}>
            {status.kind === "saving" ? "Saving…" : props.set ? "Replace key" : "Save key"}
          </Button>
        </div>
      </Field>
      {status.kind === "saved" && (
        <p role="status" className="text-xs text-ok">
          Saved.
        </p>
      )}
    </form>
  );
}
