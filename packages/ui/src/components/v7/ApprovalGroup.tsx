import { useCallback, useState } from "react";
import type { Approval, ApprovalAnswer } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { APPROVAL_TIMEOUT_MS, answerFor, approvalDeadline, type Resolution } from "../../lib/v7/approval";
import { Button } from "../primitives/Button";
import { ApprovalCard, Countdown, useApprovalLeft, type ApprovalCardProps } from "./ApprovalCard";
import { RequestCard } from "../shared/RequestCard";

/** "3 approvals from Atlas API": several approvals waiting at once are one card with one "Allow all for this request". */
export function ApprovalGroup(props: {
  approvals: Approval[];
  source: string;
  timeoutMs?: number | undefined;
  onResolve: ApprovalCardProps["onResolve"];
  onResolved: ApprovalCardProps["onResolved"];
  onOpenAgent?: ApprovalCardProps["onOpenAgent"];
}) {
  const { approvals } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rows whose "Always allow" panel is open: while one is, its save is the one primary button and "Allow all" is secondary.
  const [alwaysOpen, setAlwaysOpen] = useState<ReadonlySet<string>>(new Set());
  const onAlwaysOpen = useCallback(
    (id: string, open: boolean) =>
      setAlwaysOpen((prev) => {
        if (prev.has(id) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  // The group's countdown is the one that runs out first.
  const timeout = props.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const deadline = (a: Approval) => approvalDeadline(a.created_at, timeout) ?? Infinity;
  const first = [...approvals].sort((a, b) => deadline(a) - deadline(b))[0];
  const left = useApprovalLeft(first?.created_at ?? null, props.timeoutMs, true);

  const allowAll = async () => {
    setBusy(true);
    setError(null);
    const answer: ApprovalAnswer = answerFor("allow_for_turn");
    const resolution: Resolution = { decision: "allow_for_turn", by: "you" };
    const failed: string[] = [];
    for (const a of approvals) {
      try {
        await props.onResolve(a.id, answer);
        props.onResolved(a.id, resolution);
      } catch (e) {
        failed.push(errorMessage(e));
      }
    }
    if (failed.length) setError(`${failed.length} of ${approvals.length} did not go through: ${failed[0]}. Answer them one by one.`);
    setBusy(false);
  };

  return (
    <RequestCard
      data-v7-approval-group=""
      title={`${approvals.length} approvals from ${props.source}`}
      meta={left !== null ? <Countdown left={left} /> : undefined}
      primary={
        <Button variant={alwaysOpen.size > 0 ? "secondary" : "primary"} size="sm" loading={busy} disabled={busy} onClick={() => void allowAll()}>
          Allow all for this request
        </Button>
      }
      error={error}
    >
      <div className="-mx-card flex flex-col divide-y divide-line">
        {approvals.map((a) => (
          <ApprovalCard
            key={a.id}
            compact
            approval={a}
            resolution={null}
            {...(props.timeoutMs !== undefined ? { timeoutMs: props.timeoutMs } : {})}
            onResolve={props.onResolve}
            onResolved={props.onResolved}
            onAlwaysOpen={onAlwaysOpen}
            {...(props.onOpenAgent ? { onOpenAgent: props.onOpenAgent } : {})}
          />
        ))}
      </div>
    </RequestCard>
  );
}
