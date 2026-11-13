import { useState } from "react";
import { errorMessage } from "../../lib/format";
import { USE_ANYWAY_NOTE, recheckAgent } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Spinner } from "../primitives/Status";

/**
 * The two ways out of a refused model switch whose only reason is a login the probe could not confirm (decision
 * 2026-11-12, the probe is advisory): "Check again" asks the harness to probe now and retries when it passes; "Use
 * anyway" repeats the request with `force_unverified`.
 */
export function ModelRefusedActions({ provider, onRetry, onForce }: { provider: string; onRetry(): void; onForce(): void }) {
  const { bridge } = useApp();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const check = () => {
    setRunning(true);
    setNote("");
    recheckAgent(bridge, provider).then(
      (ready) => {
        setRunning(false);
        if (ready) onRetry();
        else setNote("Still logged out.");
      },
      (e: unknown) => {
        setRunning(false);
        setNote(`Could not check: ${errorMessage(e).replace(/\.$/, "")}.`);
      },
    );
  };
  return (
    <>
      <span className="basis-full text-xs text-fg-3">{USE_ANYWAY_NOTE}</span>
      {note && (
        <span role="status" className="text-xs text-warn">
          {note}
        </span>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={check} disabled={running} aria-busy={running}>
        {running ? <Spinner size={10} /> : "Check again"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onForce} disabled={running}>
        Use anyway
      </Button>
    </>
  );
}
