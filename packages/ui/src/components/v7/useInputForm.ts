import { useCallback, useRef, useState, type SyntheticEvent } from "react";
import type { AnsweredInput, InputAnswer, InputRequest } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { buildAnswer, fieldsInError, initialValues, localAnswered, validate, type FormValues } from "../../lib/v7/form";

function without(errors: Record<string, string>, id: string): Record<string, string> {
  if (!(id in errors)) return errors;
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k !== id));
}

/**
 * Behaviour of an open form card (decision 43). Non-secret values are React state; secret values never are: they stay in
 * their (uncontrolled) inputs, are read once at submit, handed to the bridge, and the inputs are emptied on success.
 */
export function useInputForm(props: {
  request: InputRequest;
  onSubmit(id: string, answer: InputAnswer): Promise<void>;
  onAnswered(id: string, answered: AnsweredInput): void;
}) {
  const { request, onSubmit, onAnswered } = props;
  const [values, setValues] = useState<FormValues>(() => initialValues(request.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Each field's control by field id: secrets are read from here, and the first invalid field is focused. */
  const controls = useRef(new Map<string, HTMLElement>());

  const registerControl = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) controls.current.set(id, el);
      else controls.current.delete(id);
    },
    [],
  );

  const secretInputs = useCallback(() => {
    const out: [string, HTMLInputElement][] = [];
    for (const f of request.fields) {
      const el = controls.current.get(f.id);
      if (f.kind === "secret" && el instanceof HTMLInputElement) out.push([f.id, el]);
    }
    return out;
  }, [request.fields]);

  const set = useCallback((id: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors((e) => without(e, id));
  }, []);

  const clearError = useCallback((id: string) => setErrors((e) => without(e, id)), []);

  const send = useCallback(
    async (kind: "submit" | "skip", answer: InputAnswer) => {
      setBusy(kind);
      setError(null);
      try {
        await onSubmit(request.id, answer);
        for (const [, el] of secretInputs()) el.value = "";
        onAnswered(request.id, localAnswered(request.fields, answer));
      } catch (e) {
        const message = errorMessage(e);
        const named = fieldsInError(message, request.fields);
        if (named.length) setErrors(Object.fromEntries(named.map((id) => [id, "The harness refused this value"])));
        setError(`The form was not sent: ${message}. Fix the marked fields or try again.`);
      } finally {
        setBusy(null);
      }
    },
    [onAnswered, onSubmit, request.fields, request.id, secretInputs],
  );

  const submit = useCallback(
    (e: SyntheticEvent) => {
      e.preventDefault();
      if (busy) return;
      const secrets: Record<string, string> = {};
      for (const [id, el] of secretInputs()) if (el.value) secrets[id] = el.value;
      const found = validate(request.fields, values, secrets);
      setErrors(found);
      const first = request.fields.find((f) => f.id in found);
      if (first) {
        controls.current.get(first.id)?.focus();
        return;
      }
      void send("submit", buildAnswer(request.fields, values, secrets));
    },
    [busy, request.fields, secretInputs, send, values],
  );

  const skip = useCallback(() => {
    if (!busy) void send("skip", { skip: true });
  }, [busy, send]);

  return { values, errors, busy, error, set, clearError, registerControl, submit, skip };
}

/** DOM id of a field's control (labels and error descriptions point at it). */
export function fieldDomId(formId: string, fieldId: string): string {
  return `v7-${formId}-${fieldId}`;
}
