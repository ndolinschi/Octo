import type { ErrorFields } from "@octo/agent-client";
import { useState } from "react";
import { errorMessage } from "../../lib/format";
import { isStructured, plainError } from "../../lib/errors/plain";
import { useProject } from "../../state/project";
import { Notice } from "../primitives/Notice";
import { ErrorNotice } from "../shared/ErrorNotice";
import { runRetry, splitHint } from "./outcome";

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
  const structured = { message: (props.error ?? "").trim(), ...props.fields };
  const legacy = splitHint(props.error, props.fields?.hint);
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
