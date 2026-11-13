import type { Bridge, Plan } from "@octo/agent-client";
import { Check, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { errorCode, errorMessage } from "../../lib/format";
import { planError } from "../../lib/modeLabels";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Card } from "../primitives/Card";
import { RequestCard } from "../shared/RequestCard";
import { LazyMarkdown } from "./LazyMarkdown";

/**
 * Parity B3: the card a plan turn ends with. A pending plan shows its text with "Approve and run" (starts an Agent turn
 * with the plan pinned) and "Keep editing" (back to the composer, still in Plan mode); an approved plan folds to one line.
 * It loads with the first plan (its own chunk).
 */
function PlanCard(props: { plan: Plan; onPlan(plan: Plan): void; onRefresh(): Promise<void>; onKeepEditing(): void }) {
  const { plan } = props;
  const { bridge } = useApp();
  const { projectId, running } = useProject();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const approved = plan.status === "approved";

  const approve = async () => {
    if (!bridge.approvePlan || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.approvePlan(projectId, plan.id);
      props.onPlan(result.plan);
    } catch (e) {
      const known = planError(errorCode(e));
      if (known?.refresh) await props.onRefresh().catch(() => undefined);
      setProblem(known?.text ?? `Could not approve the plan: ${errorMessage(e).replace(/\.$/, "")}. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  if (approved) {
    return (
      <div data-plan="approved" role="group" aria-label="Approved plan" className="text-sm">
        <Card surface="panel" padding="none">
          <Button variant="quiet" size="md" fullWidth aria-expanded={open} onClick={() => setOpen((o) => !o)} className="justify-start px-3">
            <Glyph icon={Check} size={14} className="shrink-0 text-ok" />
            <span className="text-left">Plan approved</span>
            <Glyph icon={ChevronRight} size={14} className={cn("text-fg-3", open && "rotate-90")} />
          </Button>
          {open && (
            <div className="border-t border-line px-3 py-2">
              <LazyMarkdown text={plan.text} className="octo-prose" />
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <RequestCard
      data-plan="pending"
      aria-label="Plan to approve"
      title="Plan"
      asks="Approve it to start the work"
      glyph="needs"
      primary={
        <Button variant="primary" size="sm" disabled={busy || running} loading={busy} onClick={() => void approve()}>
          Approve and run
        </Button>
      }
      alternatives={
        <Button variant="quiet" size="sm" disabled={busy} onClick={props.onKeepEditing}>
          Keep editing
        </Button>
      }
      error={problem}
    >
      <div className="max-h-80 overflow-y-auto">
        <LazyMarkdown text={plan.text} className="octo-prose" />
      </div>
      {running && !problem && <p className="text-fg-3">A turn is running.</p>}
    </RequestCard>
  );
}

/** The newest plan, asked once for all the cards that look (one request per project within a second). */
const latest = new Map<string, { at: number; plan: Promise<Plan | null> }>();
function latestPlan(bridge: Bridge, projectId: string): Promise<Plan | null> {
  const hit = latest.get(projectId);
  if (hit && Date.now() - hit.at < 1000) return hit.plan;
  // 404: no plan turn yet. Any other failure: plans still arrive as events, and a reload asks again.
  const plan = (bridge.getLatestPlan?.(projectId) ?? Promise.resolve(null)).catch(() => null);
  latest.set(projectId, { at: Date.now(), plan });
  return plan;
}

/**
 * The plan that answers request `turnId`, if there is one (parity B3): read with `getLatestPlan`, kept current by
 * `plan.created` / `plan.approved`, dropped when a rewind cuts that request. The whole feature lives in this chunk, so the
 * transcript only mounts it under the newest requests.
 */
export function PlanForTurn(props: { turnId: number; onKeepEditing(): void }) {
  const { bridge } = useApp();
  const { projectId, onEvent } = useProject();
  const [plan, setPlan] = useState<Plan | null>(null);
  const { turnId } = props;
  useEffect(() => {
    let alive = true;
    void latestPlan(bridge, projectId).then((p) => alive && p?.turn_id === turnId && setPlan(p));
    const off = onEvent((e) => {
      if ((e.type === "plan.created" || e.type === "plan.approved") && e.plan.turn_id === turnId) setPlan(e.plan);
      if (e.type === "conversation.rewound" && e.message_id <= turnId) setPlan(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge, projectId, onEvent, turnId]);
  const refresh = useCallback(async () => {
    const p = await bridge.getLatestPlan?.(projectId);
    if (p?.turn_id === turnId) setPlan(p);
  }, [bridge, projectId, turnId]);
  return plan ? <PlanCard plan={plan} onPlan={setPlan} onRefresh={refresh} onKeepEditing={props.onKeepEditing} /> : null;
}
