import { Check, Lock, SkipForward, X } from "lucide-react";
import { useMemo, useState, type SyntheticEvent } from "react";
import type { AnsweredInput, InputAnswer, InputRequest } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { answeredLine, SECRET_MIN_BYTES, utf8Length } from "../../lib/v7/form";
import { Button } from "../primitives/Button";
import { TextField } from "../primitives/TextField";
import { Glyph } from "../primitives/Glyph";
import { Card } from "../primitives/Card";
import { Notice } from "../primitives/Notice";
import type { NormalForm } from "../../lib/schemaForm/schema";
import { formOfRequest, localAnswered } from "../../lib/schemaForm/summary";
import { RequestCard } from "../shared/RequestCard";
import { SchemaForm } from "../shared/SchemaForm";
import { useSchemaForm } from "../shared/useSchemaForm";
import { focusOnMount } from "./parts";

export type InputFormCardProps = {
  request: InputRequest;
  /** Set once answered (from `input.resolved` or this card's own submit): the card is one line of names. */
  answered: AnsweredInput | null;
  /** Posts to the harness (`submitInput`); secret values go only here. */
  onSubmit(id: string, answer: InputAnswer): Promise<void>;
  onAnswered(id: string, answered: AnsweredInput): void;
  /** Replaces a stored secret (`putSecret`): the answered line offers "Change" for each provided secret. */
  onReplaceSecret?(name: string, value: string): Promise<void>;
};

/** A form an agent asked for (`request_input`, decision 43; schema forms, spec 2026-11-15 §A): values go to the harness, never to the model. */
export function InputFormCard(props: InputFormCardProps) {
  if (props.answered) return <AnsweredForm request={props.request} answered={props.answered} onReplaceSecret={props.onReplaceSecret} />;
  return <OpenForm {...props} />;
}

function OpenForm(props: InputFormCardProps) {
  const parsed = useMemo(() => formOfRequest(props.request), [props.request]);
  if (!parsed.ok) return <BrokenForm {...props} reason={parsed.reason} />;
  return <SchemaCard {...props} form={parsed.form} />;
}

function SchemaCard(props: InputFormCardProps & { form: NormalForm }) {
  const { request, form, onSubmit, onAnswered } = props;
  const f = useSchemaForm({
    form,
    onSubmit: async (answer) => {
      await onSubmit(request.id, answer);
      onAnswered(request.id, localAnswered(form, answer));
    },
    onSkip: async () => {
      await onSubmit(request.id, { skip: true });
      onAnswered(request.id, { status: "skipped", provided: [], values: {} });
    },
  });
  const hasSecret = form.fields.some((x) => x.secret);
  const { attachForm } = f;
  return (
    <form noValidate ref={attachForm} onSubmit={(e) => void f.submit(e)} className="contents">
      <RequestCard
        aria-labelledby={`v7-form-${request.id}`}
        data-v7-form={request.id}
        titleId={`v7-form-${request.id}`}
        title={request.title}
        asks={request.agent_label}
        primary={
          <Button type="submit" variant="primary" size="sm" disabled={f.busy !== null} loading={f.busy === "submit"}>
            {form.submitLabel ?? "Submit"}
          </Button>
        }
        alternatives={
          <Button variant="quiet" size="sm" disabled={f.busy !== null} loading={f.busy === "skip"} onClick={() => void f.skip()}>
            Skip
          </Button>
        }
        error={f.error}
      >
        {request.reason && <p className="[overflow-wrap:anywhere] text-fg-2">{request.reason}</p>}
        <SchemaForm form={form} state={f} idPrefix={`v7-${request.id}`} />
        <SentNote secret={hasSecret} />
      </RequestCard>
    </form>
  );
}

function SentNote({ secret }: { secret: boolean }) {
  return (
    <p className="flex items-start gap-2 text-xs text-fg-3">
      <span aria-hidden className="grid h-4 shrink-0 place-items-center">
        <Glyph icon={Lock} size={14} />
      </span>
      <span>
        Sent to Octo's local service, not to the model.
        {secret && " Secrets are stored for this project; the agent only learns that they were provided."}
      </span>
    </p>
  );
}

/** A form whose schema this UI cannot show: it says why and can still be skipped, so the agent is not left waiting. */
function BrokenForm(props: InputFormCardProps & { reason: string }) {
  const { request, onSubmit, onAnswered } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skip = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(request.id, { skip: true });
      onAnswered(request.id, { status: "skipped", provided: [], values: {} });
    } catch (e) {
      setError(`Not skipped: ${errorMessage(e)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequestCard
      aria-labelledby={`v7-form-${request.id}`}
      data-v7-form={request.id}
      titleId={`v7-form-${request.id}`}
      title={request.title}
      asks={request.agent_label}
      alternatives={
        <Button variant="quiet" size="sm" disabled={busy} loading={busy} onClick={() => void skip()}>
          Skip
        </Button>
      }
      error={error}
    >
      <Notice tone="warn">This form could not be shown: {props.reason}.</Notice>
    </RequestCard>
  );
}

/** One line once answered: names only ("API key provided · Region answered"), plus "Change" for a provided secret. */
function AnsweredForm({
  request,
  answered,
  onReplaceSecret,
}: Pick<InputFormCardProps, "request"> & { answered: AnsweredInput; onReplaceSecret: InputFormCardProps["onReplaceSecret"] | undefined }) {
  const line = answeredLine(request, answered);
  const parsed = formOfRequest(request);
  const titleOf = (id: string) => (parsed.ok ? parsed.form.fields.find((x) => x.id === id)?.title : undefined) ?? id;
  const [changing, setChanging] = useState<string | null>(null);
  const icon = line.status === "submitted" ? Check : line.status === "skipped" ? SkipForward : X;
  const secrets = onReplaceSecret ? answered.provided : [];
  return (
    <div role="group" aria-label={`${request.title}: ${line.text}`} data-v7-form={request.id} data-resolved="" className="@container/v7 text-sm">
      <Card padding="none">
        <div className="flex min-h-ctl-md min-w-0 items-center gap-2 px-3 py-1">
          <Glyph icon={icon} size={14} className={cn("shrink-0", line.status === "submitted" ? "text-ok" : "text-fg-3")} />
          <span className="min-w-0 flex-1 wrap-anywhere">
            <span className="text-fg-2">{request.title}</span>
            <span className="text-fg-3"> · {line.text}</span>
          </span>
          {secrets.length > 0 && (
            <span className="flex flex-wrap justify-end gap-1">
              {secrets.map((id) => (
                <Button key={id} variant="quiet" size="xs" aria-expanded={changing === id} onClick={() => setChanging(changing === id ? null : id)}>
                  {secrets.length > 1 ? `Change ${titleOf(id)}` : "Change"}
                </Button>
              ))}
            </span>
          )}
        </div>
        {changing && onReplaceSecret && (
          <ReplaceSecret name={changing} label={titleOf(changing)} onReplace={onReplaceSecret} onDone={() => setChanging(null)} />
        )}
      </Card>
    </div>
  );
}

/** Replaces one stored secret; the value lives only in the input and is emptied once stored. */
function ReplaceSecret(props: { name: string; label: string; onReplace(name: string, value: string): Promise<void>; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `v7-replace-${props.name}`;
  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("secret");
    if (!(input instanceof HTMLInputElement)) return;
    if (utf8Length(input.value) < SECRET_MIN_BYTES) {
      setError(`At least ${SECRET_MIN_BYTES} characters.`);
      input.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onReplace(props.name, input.value);
      input.value = "";
      props.onDone();
    } catch (err) {
      setError(`Not stored: ${errorMessage(err)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-2 border-t border-line p-3">
      <label htmlFor={id} className="sr-only">
        New value for {props.label}
      </label>
      <TextField
        id={id}
        size="sm"
        name="secret"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={`New ${props.label}`}
        ref={focusOnMount}
        className="min-w-0 flex-1 basis-48 font-mono"
        aria-invalid={error ? true : undefined}
      />
      <Button type="submit" variant="primary" size="sm" disabled={busy} loading={busy}>
        Save
      </Button>
      <Button variant="quiet" size="sm" onClick={props.onDone}>
        Cancel
      </Button>
      {error && (
        <Notice tone="error" className="basis-full">
          {error}
        </Notice>
      )}
    </form>
  );
}
