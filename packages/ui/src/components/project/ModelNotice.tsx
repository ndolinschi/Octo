import { useState } from "react";
import { useApp } from "../../state/app";
import type { NotReady } from "../../lib/errors/modelReadiness";
import { recheckAgent } from "../../lib/providers/recheck";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";

/**
 * Above the dialog's buttons when a chosen model cannot run now: what is wrong in plain words, the login command to copy, "Check
 * again" and "Choose another model". Never an error and never a block: "Create project" stays on (decision 2026-11-15).
 */
export function ModelNotice(props: { issue: NotReady; onChoose(): void }) {
  const { bridge } = useApp();
  const { issue } = props;
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  const check = () => {
    if (!issue.agentId) return;
    setChecking(true);
    setStill(false);
    void recheckAgent(bridge, issue.agentId)
      // A failed read leaves the notice as it was; "Check again" can be pressed again.
      .catch(() => false)
      .then((ready) => setStill(!ready))
      .finally(() => setChecking(false));
  };
  return (
    <Notice
      tone="warn"
      form="block"
      {...(issue.command ? { command: issue.command } : {})}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={props.onChoose}>
            Choose another model
          </Button>
          {issue.agentId && (
            <Button size="sm" variant="secondary" loading={checking} onClick={check}>
              Check again
            </Button>
          )}
        </>
      }
    >
      {issue.text}
      {still && <span className="mt-1 block text-fg-3">Still not ready. Finish the step above, then check again.</span>}
    </Notice>
  );
}
