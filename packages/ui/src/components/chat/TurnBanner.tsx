import type { ErrorFields } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { loginSteps, withLoginSteps, type LoginSteps } from "../../lib/errors/login";
import { isStructured, plainError } from "../../lib/errors/plain";
import { isRestartInterruption } from "../../lib/transcript";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Notice } from "../primitives/Notice";
import { ErrorNotice } from "../shared/ErrorNotice";
import { isCompactRetry, runRetry, splitHint } from "./outcome";

/** The login command of the agent `id` from the plugin list, while it is not logged in (an agent row keeps no `command`). */
function useLoginSteps(id: string | undefined, wanted: boolean): LoginSteps | null {
  const activity = useActivity();
  const [steps, setSteps] = useState<LoginSteps | null>(null);
  useEffect(() => {
    if (!id || !wanted) return;
    let alive = true;
    activity.plugins().then(
      (plugins) => alive && setSteps(loginSteps(plugins.flatMap((p) => p.agents).find((a) => a.id === id))),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [activity, id, wanted]);
  return steps;
}

/**
 * The notice under a failed or stopped turn (decision 94b) with its Retry. A chunk of its own, warmed right after first
 * paint: the error mapping and the notice are not in the entry bundle. G13: it comes in with the one calm fade (`.octo-fade`,
 * opacity only, 120 ms; none under reduced motion).
 */
export function TurnBanner(props: {
  status: "failed" | "cancelled";
  error: string | null;
  /** NEW-1: `error` is the text of the turn's own failed step, not the turn's error: mapped like an older harness's bare text. */
  fromStep?: boolean;
  retryText: string | null;
  /** Slash command name on the failed prompt (for example `"compact"`). */
  retryCommand?: string | null | undefined;
  /** hint, command, action and details of the failure, as the harness sent them. */
  fields?: ErrorFields | undefined;
  agent?: string | undefined;
  providerId?: string | undefined;
  /** Already on the composer's edge (the empty project's start failure): no outset. In the transcript the banner spans the
   *  column's whole edge, like the user bubble and the composer (7b). */
  flush?: boolean;
  /** Re-reads the agent's login; true when it is ready now (the failed request is then sent again). */
  onCheck?: (() => Promise<boolean>) | undefined;
}) {
  const { bridge } = useApp();
  const { projectId, send, running } = useProject();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const failed = props.status === "failed";
  // Only a recheck-the-login failure needs the command (the harness's own `command` always wins).
  const steps = useLoginSteps(props.providerId, failed && props.fields?.action === "recheck_provider" && !props.fields.command);
  // A turn the harness closed after a restart (P1-1): after a reload its row keeps the sentence and hint, not the action.
  const restarted = failed && isRestartInterruption(props.error) && !props.fields?.action;
  const fields = withLoginSteps(restarted ? { ...props.fields, action: "retry" as const } : props.fields, steps);
  const retryText = props.retryText;
  const compact = isCompactRetry(retryText, props.retryCommand);
  const canRetry = (retryText !== null || compact) && !running;

  const retry = async () => {
    if (compact && bridge.compactNow) {
      setRetryError(null);
      await runRetry(() => bridge.compactNow!(projectId), retryText ?? "/compact", { setBusy, onError: (e) => setRetryError(errorMessage(e)) });
      return;
    }
    if (!retryText) return;
    setRetryError(null);
    await runRetry(send, retryText, { setBusy, onError: (e) => setRetryError(errorMessage(e)) });
  };

  if (!failed) {
    return (
      <div data-turn-outcome="cancelled" className={cn("octo-fade", !props.flush && "-mx-3")}>
        <Notice tone="info">{retryText !== null ? "Stopped. Send a message to continue." : "Stopped."}</Notice>
      </div>
    );
  }
  const structured = { message: (props.error ?? "").trim(), ...fields };
  const legacy = splitHint(props.error, fields?.hint);
  const check = props.onCheck
    ? async () => {
        const ready = await props.onCheck?.();
        if (ready === true && canRetry) await retry();
      }
    : undefined;
  return (
    <div data-turn-outcome="failed" className={cn("octo-fade", !props.flush && "-mx-3")}>
      <ErrorNotice
        fields={!props.fromStep && isStructured(structured) ? structured : undefined}
        raw={legacy.error || null}
        hint={legacy.hint}
        agent={props.agent}
        providerId={props.providerId}
        onCheck={check}
        hideChecked={retryError !== null}
        onRetry={canRetry ? () => void retry() : undefined}
        retrying={busy}
        actions={retryError ? <Notice tone="error">Retry failed: {plainError(retryError, { agent: props.agent }).sentence}</Notice> : undefined}
      />
    </div>
  );
}
