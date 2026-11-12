import { Check, Lock, SkipForward, X } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import type { AnsweredInput, InputAnswer, InputRequest } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { answeredLine, SECRET_MIN_BYTES, utf8Length } from "../../lib/v7/form";
import { Button } from "../primitives/Button";
import { TextField } from "../primitives/TextField";
import { Glyph } from "../primitives/Glyph";
import { Card } from "../primitives/Card";
import { Notice } from "../primitives/Notice";
import { RequestCard } from "../shared/RequestCard";
import { FormField } from "./FormFields";
import { focusOnMount } from "./parts";
import { fieldDomId, useInputForm } from "./useInputForm";

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

/** A form an agent asked for (`request_input`, decision 43): values go to the harness, never to the model. */
export function InputFormCard(props: InputFormCardProps) {
  if (props.answered) return <AnsweredForm request={props.request} answered={props.answered} onReplaceSecret={props.onReplaceSecret} />;
  return <OpenForm {...props} />;
}

function OpenForm(props: InputFormCardProps) {
  const { request } = props;
  const f = useInputForm(props);
  const hasSecret = request.fields.some((x) => x.kind === "secret");
  return (
    <form noValidate onSubmit={f.submit} className="contents">
      <RequestCard
        aria-labelledby={`v7-form-${request.id}`}
        data-v7-form={request.id}
        titleId={`v7-form-${request.id}`}
        title={request.title}
        asks={request.agent_label}
        primary={
          <Button type="submit" variant="primary" size="sm" disabled={f.busy !== null} loading={f.busy === "submit"}>
            Submit
          </Button>
        }
        alternatives={
          <Button variant="quiet" size="sm" disabled={f.busy !== null} loading={f.busy === "skip"} onClick={f.skip}>
            Skip
          </Button>
        }
        error={f.error}
      >
        {request.reason && <p className="[overflow-wrap:anywhere] text-fg-2">{request.reason}</p>}
        <div className="flex flex-col gap-3">
          {request.fields.map((field) => (
            <FormField
              key={field.id}
              field={field}
              domId={fieldDomId(request.id, field.id)}
              value={f.values[field.id]}
              error={f.errors[field.id]}
              disabled={f.busy !== null}
              registerControl={f.registerControl(field.id)}
              onChange={(v) => f.set(field.id, v)}
              onSecretInput={() => f.clearError(field.id)}
            />
          ))}
        </div>
        <p className="flex items-start gap-2 text-xs text-fg-3">
          <Glyph icon={Lock} size={14} className="mt-px shrink-0" />
          <span>
            Sent to the harness, not to the model.
            {hasSecret && " Secrets are stored for this project; the agent only learns that they were provided."}
          </span>
        </p>
      </RequestCard>
    </form>
  );
}

/** One line once answered: names only ("API key provided · Region answered"), plus "Change" for a provided secret. */
function AnsweredForm({
  request,
  answered,
  onReplaceSecret,
}: Pick<InputFormCardProps, "request"> & { answered: AnsweredInput; onReplaceSecret: InputFormCardProps["onReplaceSecret"] | undefined }) {
  const line = answeredLine(request, answered);
  const [changing, setChanging] = useState<string | null>(null);
  const icon = line.status === "submitted" ? Check : line.status === "skipped" ? SkipForward : X;
  const secrets = onReplaceSecret ? answered.provided : [];
  return (
    <div role="group" aria-label={`${request.title}: ${line.text}`} data-v7-form={request.id} data-resolved="" className="@container/v7 text-sm">
      <Card surface="panel" padding="none">
        <div className="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1">
          <Glyph icon={icon} size={14} className={cn("shrink-0", line.status === "submitted" ? "text-ok" : "text-fg-3")} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="text-fg-2">{request.title}</span>
            <span className="text-fg-3"> · {line.text}</span>
          </span>
          {secrets.length > 0 && (
            <span className="flex shrink-0 gap-1">
              {secrets.map((id) => (
                <Button key={id} variant="quiet" size="xs" aria-expanded={changing === id} onClick={() => setChanging(changing === id ? null : id)}>
                  {secrets.length > 1 ? `Change ${request.fields.find((x) => x.id === id)?.label ?? id}` : "Change"}
                </Button>
              ))}
            </span>
          )}
        </div>
        {changing && onReplaceSecret && (
          <ReplaceSecret
            name={changing}
            label={request.fields.find((x) => x.id === changing)?.label ?? changing}
            onReplace={onReplaceSecret}
            onDone={() => setChanging(null)}
          />
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
