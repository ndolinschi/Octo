import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { BridgeError, type InputAnswer } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { attentionLine } from "../../lib/schemaForm/check";
import { answerOf, hasMultiline, initialDrafts, shownFields, validateDrafts, type Draft, type Drafts } from "../../lib/schemaForm/draft";
import type { NormalForm } from "../../lib/schemaForm/schema";
import { fieldsInMessage } from "../../lib/schemaForm/summary";

/** Words for a field the service refused without saying why (an older harness names the field only). */
const REFUSED = "Octo's local service refused this value";

function only(errors: Record<string, string>, keep: (id: string) => boolean): Record<string, string> {
  const out = Object.fromEntries(Object.entries(errors).filter(([id]) => keep(id)));
  return Object.keys(out).length === Object.keys(errors).length ? errors : out;
}

/**
 * Behaviour of an open schema form (spec 2026-11-15 §A.3–A.4). Drafts are React state; secret values never are: they stay
 * in their (uncontrolled) inputs, are read at submit, handed to `onSubmit` and the inputs are emptied after a success.
 * Checks run when a filled field loses focus and on submit; a failed submit focuses the first invalid field and says how
 * many need attention in the form's own live region.
 */
export function useSchemaForm(props: { form: NormalForm; onSubmit(answer: InputAnswer): Promise<void>; onSkip?(): Promise<void> }) {
  const { form, onSubmit, onSkip } = props;
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(form));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const controls = useRef(new Map<string, HTMLElement>());
  const shown = useMemo(() => shownFields(form, drafts), [form, drafts]);

  const registerControl = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) controls.current.set(id, el);
      else controls.current.delete(id);
    },
    [],
  );

  const secretInputs = useCallback(() => {
    const out: [string, HTMLInputElement][] = [];
    for (const f of form.fields) {
      const el = controls.current.get(f.id);
      if (f.secret && el instanceof HTMLInputElement) out.push([f.id, el]);
    }
    return out;
  }, [form]);
  const secrets = useCallback(
    () =>
      Object.fromEntries(
        secretInputs()
          .filter(([, el]) => el.value !== "")
          .map(([id, el]) => [id, el.value]),
      ),
    [secretInputs],
  );

  const focusField = useCallback((id: string) => {
    const el = controls.current.get(id);
    if (!el) return;
    const target = el.matches("input, textarea, button") ? el : (el.querySelector<HTMLElement>('[tabindex="0"], input, textarea, button') ?? el);
    target.focus();
  }, []);

  const setDraft = useCallback(
    (id: string, value: Draft) => {
      const next = { ...drafts, [id]: value };
      setDrafts(next);
      const visible = shownFields(form, next);
      // An error that is showing follows the value (it clears as soon as the value is right); others wait for blur or submit.
      setErrors((e) => {
        const kept = only(e, (k) => visible.has(k));
        if (!(id in kept)) return kept;
        const now = validateDrafts(form, next, secrets())[id];
        return now ? { ...kept, [id]: now } : only(kept, (k) => k !== id);
      });
    },
    [drafts, form, secrets],
  );

  const blur = useCallback(
    (id: string, to?: EventTarget | null) => {
      // Focus that goes to a button of this form (Submit, Skip) is the press of that button: an error painted now would
      // move the button under the pointer and the click would be lost. Submit checks every field itself.
      if (to instanceof HTMLButtonElement && to.form !== null && to.form === controls.current.get(id)?.closest("form")) return;
      const f = form.fields.find((x) => x.id === id);
      if (!f) return;
      const s = secrets();
      const d = drafts[id];
      const blank = f.secret ? !s[id] : d === undefined || d === "" || (Array.isArray(d) && d.length === 0);
      // A field left empty is said to be required only on submit: tabbing through a form does not paint it red.
      if (blank && !(id in errors)) return;
      const now = validateDrafts(form, drafts, s)[id];
      setErrors((e) => (now ? { ...e, [id]: now } : only(e, (k) => k !== id)));
    },
    [drafts, errors, form, secrets],
  );

  const clearError = useCallback((id: string) => setErrors((e) => only(e, (k) => k !== id)), []);

  const fail = useCallback(
    (found: Record<string, string>) => {
      setErrors(found);
      const ids = form.fields.map((f) => f.id).filter((id) => id in found);
      const first = ids[0];
      if (first) focusField(first);
      // The same words twice in a row still change the region (a no-break space), so they are read again.
      setAnnounce((a) => (a === attentionLine(ids.length) ? `${attentionLine(ids.length)} ` : attentionLine(ids.length)));
    },
    [focusField, form],
  );

  const submit = useCallback(
    async (e?: SyntheticEvent) => {
      e?.preventDefault();
      if (busy) return;
      const s = secrets();
      const found = validateDrafts(form, drafts, s);
      if (Object.keys(found).length) {
        fail(found);
        return;
      }
      setErrors({});
      setBusy("submit");
      setError(null);
      try {
        await onSubmit(answerOf(form, drafts, s));
        for (const [, el] of secretInputs()) el.value = "";
      } catch (err) {
        const ids = form.fields.map((f) => f.id);
        const byField = err instanceof BridgeError && err.fields ? Object.fromEntries(Object.entries(err.fields).filter(([id]) => ids.includes(id))) : null;
        const named = byField && Object.keys(byField).length ? byField : Object.fromEntries(fieldsInMessage(errorMessage(err), ids).map((id) => [id, REFUSED]));
        if (Object.keys(named).length) {
          fail(named);
          setError("The form was not submitted. Fix the marked fields, then submit again.");
        } else setError(`The form was not submitted: ${errorMessage(err)}. Try again.`);
      } finally {
        setBusy(null);
      }
    },
    [busy, drafts, fail, form, onSubmit, secretInputs, secrets],
  );

  const skip = useCallback(async () => {
    if (busy || !onSkip) return;
    setBusy("skip");
    setError(null);
    try {
      await onSkip();
    } catch (err) {
      setError(`Not skipped: ${errorMessage(err)}. Try again.`);
    } finally {
      setBusy(null);
    }
  }, [busy, onSkip]);

  const multiline = hasMultiline(form);
  // Ctrl/Cmd+Enter submits any form; Enter in a one-line field submits natively (the form has a submit button). A native
  // listener on the form element: the keys come from any of its controls.
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  useEffect(() => {
    if (!formEl) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    };
    formEl.addEventListener("keydown", onKey);
    return () => formEl.removeEventListener("keydown", onKey);
  }, [formEl, submit]);

  return { drafts, errors, shown, busy, error, announce, multiline, setDraft, blur, clearError, registerControl, submit, skip, attachForm: setFormEl };
}

export type SchemaFormState = ReturnType<typeof useSchemaForm>;
