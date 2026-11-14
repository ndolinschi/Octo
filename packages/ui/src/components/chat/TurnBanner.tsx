import type { ErrorFields } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { loginSteps, withLoginSteps, type LoginSteps } from "../../lib/errors/login";
import { isStructured, plainError } from "../../lib/errors/plain";
import { isRestartInterruption } from "../../lib/transcript";
import { useActivity } from "../../state/activity";
import { useProject } from "../../state/project";
import { Notice } from "../primitives/Notice";
import { ErrorNotice } from "../shared/ErrorNotice";
import { runRetry, splitHint } from "./outcome";

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
 * paint: the error mapping and the notice are not in the entry bundle.
 */
export function TurnBanner(props: {
  status: "failed" | "cancelled";
  error: string | null;
  retryText: string | null;
  /** hint, command, action and details of the failure, as the harness sent them. */
  fields?: ErrorFields | undefined;
  agent?: string | undefined;
  providerId?: string | undefined;
  /** Re-reads the agent's login; true when it is ready now (the failed request is then sent again). */
  onCheck?: (() => Promise<boolean>) | undefined;
}) {
  const { send, running } = useProject();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const failed = props.status === "failed";
  // Only a recheck-the-login failure needs the command (the harness's own `command` always wins).
  const steps = useLoginSteps(props.providerId, failed && props.fields?.action === "recheck_provider" && !props.fields.command);
  // A turn the harness closed after a restart (P1-1): after a reload its row keeps the sentence and hint, not the action.
  const restarted = failed && isRestartInterruption(props.error) && !props.fields?.action;
  const fields = withLoginSteps(restarted ? { ...props.fields, action: "retry" as const } : props.fields, steps);
  const retryText = props.retryText;

  const retry = async () => {
    if (!retryText) return;
    setRetryError(null);
    await runRetry(send, retryText, { setBusy, onError: (e) => setRetryError(errorMessage(e)) });
  };

  if (!failed) {
    return (
      <div data-turn-outcome="cancelled">
        <Notice tone="info">{retryText !== null ? "Stopped. Send a message to continue." : "Stopped."}</Notice>
      </div>
    );
  }
  const structured = { message: (props.error ?? "").trim(), ...fields };
  const legacy = splitHint(props.error, fields?.hint);
  const check = props.onCheck
    ? async () => {
        const ready = await props.onCheck?.();
        if (ready === true && retryText !== null && !running) void retry();
      }
    : undefined;
  return (
    <div data-turn-outcome="failed">
      <ErrorNotice
        fields={isStructured(structured) ? structured : undefined}
        raw={legacy.error || null}
        hint={legacy.hint}
        agent={props.agent}
        providerId={props.providerId}
        onCheck={check}
        onRetry={retryText !== null && !running ? () => void retry() : undefined}
        retrying={busy}
        actions={retryError ? <Notice tone="error">Retry failed: {plainError(retryError, { agent: props.agent }).sentence}</Notice> : undefined}
      />
    </div>
  );
}
