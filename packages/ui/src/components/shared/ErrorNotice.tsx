import { useState, type ReactNode } from "react";
import type { ErrorFields } from "@octo/agent-client";
import { isStructured, plainError, plainStructured, type PlainError } from "../../lib/errors/plain";
import { settingsHref } from "../../lib/route";
import { useShell } from "../../state/shell";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";

/** The settings section a failure's `open_settings` goes to: its own, else General. */
export function settingsSectionFor(code: string | null | undefined): string {
  if (code === "completion_off" || code === "discovery_off" || code === "invalid_model") return "models";
  if (code === "no_provider" || code === "api_key_rejected") return "providers";
  return "general";
}

/**
 * Decision 94b: a failure in the conversation. The harness's own fields come first: `message` is the sentence, `hint` the next
 * step, `command` a line to copy, `action` the button, `details` the fold. Only an older harness, which sends bare text, is
 * mapped by `lib/errors/plain.ts`. `details` never shows outside the fold.
 *
 * action: recheck_provider -> "Check again" (`onCheck`); connect_provider -> opens the connect sheet for `providerId`;
 * retry -> `onRetry`; open_settings -> the section of `code`; update_agent -> only the command and hint; switch_account ->
 * the plain Retry here, and the caller's `actions` slot holds "Use another account" and "Choose another model" (the turn banner).
 */
export function ErrorNotice(props: {
  /** The structured failure the harness sent; wins over `raw`. */
  fields?: ({ message: string } & ErrorFields) | null | undefined;
  raw?: string | null | undefined;
  code?: string | null;
  agent?: string | undefined;
  /** The provider the failure is about, for "Connect". */
  providerId?: string | undefined;
  hint?: string | null | undefined;
  tone?: "error" | "warn" | "info";
  title?: string;
  /** "Check again" (login state re-read) for `recheck_provider`. */
  onCheck?: (() => unknown) | undefined;
  /** Suppresses the "Checked just now" line (for example when checking ran a retry that failed). */
  hideChecked?: boolean | undefined;
  /** "Retry" for a `retry` step (send the same request again). */
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
  /** Extra buttons (Dismiss, Retry of another kind). */
  actions?: ReactNode;
  className?: string;
  data?: string;
}) {
  const { openConnect } = useShell();
  const p: PlainError = isStructured(props.fields)
    ? plainStructured(props.fields)
    : plainError(props.raw, { code: props.code, agent: props.agent, hint: props.hint });
  const [open, setOpen] = useState(false);
  // "Check again": busy while it runs (aria-busy, not disabled, so focus stays); when the notice is still here after it, say so.
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const checkAgain = () => {
    if (!props.onCheck) return;
    setChecked(false);
    setChecking(true);
    void Promise.resolve()
      .then(props.onCheck)
      .catch(() => undefined)
      .finally(() => {
        setChecking(false);
        setChecked(true);
      });
  };
  const command = p.next?.kind === "command" ? p.next.command : undefined;
  const check = (p.next?.kind === "check" || p.action === "recheck_provider") && props.onCheck;
  const retry = (p.next?.kind === "retry" || p.action === "retry") && props.onRetry;
  const connect = p.action === "connect_provider";
  const settings = p.action === "open_settings";
  const details = p.details && p.details !== p.sentence ? p.details : "";
  const actions = (
    <>
      {check && (
        <Button size="sm" variant="secondary" loading={checking} onClick={checkAgain}>
          Check again
        </Button>
      )}
      {retry && (
        <Button size="sm" variant="secondary" loading={props.retrying === true} disabled={props.retrying === true} onClick={props.onRetry}>
          Retry
        </Button>
      )}
      {connect && (
        <Button size="sm" variant="secondary" onClick={() => openConnect(props.providerId ?? "providers")}>
          Connect
        </Button>
      )}
      {settings && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            window.location.hash = settingsHref(settingsSectionFor(props.code));
          }}
        >
          Open settings
        </Button>
      )}
      {props.actions}
      {details && (
        <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Details"}
        </Button>
      )}
    </>
  );
  return (
    <div data-error-notice={props.data} className={props.className}>
      <Notice tone={props.tone ?? "error"} form="block" {...(props.title ? { title: props.title } : {})} {...(command ? { command } : {})} actions={actions}>
        {p.sentence}
        {p.hint && <span className="block text-fg-3">{p.hint.replace(/`/g, "")}</span>}
        {checked && !checking && !props.hideChecked && (
          <span role="status" className="block text-xs text-fg-3">
            {/log(?:ged)? ?in/i.test(`${p.sentence} ${p.hint ?? ""}`) ? "Checked just now — still not logged in" : "Checked just now — nothing has changed"}
          </span>
        )}
        {open && details && <p className="mt-2 font-mono text-xs break-words whitespace-pre-wrap text-fg-3">{details}</p>}
      </Notice>
    </div>
  );
}
