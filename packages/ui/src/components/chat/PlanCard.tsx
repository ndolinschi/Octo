import type { Bridge, Plan } from "@octo/agent-client";
import { Check, ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { errorCode, errorMessage } from "../../lib/format";
import { planError } from "../../lib/modeLabels";
import { planTitle } from "../../lib/planTitle";
import { useApp } from "../../state/app";
import { dropPlansFromTurn, setPlanTabState, usePlanTab } from "../../state/planTabs";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Card } from "../primitives/Card";
import { RequestCard } from "../shared/RequestCard";
import { LazyMarkdown } from "./LazyMarkdown";

/**
 * Parity B3: the card a plan turn ends with. A pending plan shows its text with "Approve and run" (starts an Agent turn
 * with the plan pinned), "Open in tab" (opens the full plan beside the conversation), and "Revise in chat" (focuses the
 * composer in Plan mode); an approved plan folds to one line. It loads with the first plan (its own chunk).
 */
function PlanCard(props: { plan: Plan; onPlan(plan: Plan): void; onRefresh(): Promise<void>; onKeepEditing(): void }) {
  const { plan } = props;
  const { bridge } = useApp();
  const { projectId, running } = useProject();
  const ws = useOptionalWorkspace();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const approved = plan.status === "approved";
  const shown = planTitle(plan.text);

  const openInTab = () => {
    setPlanTabState(projectId, plan, shown.title);
    ws?.openPlan(plan.id);
  };

  const approve = async () => {
    if (!bridge.approvePlan || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.approvePlan(projectId, plan.id);
      setPlanTabState(projectId, result.plan, planTitle(result.plan.text).title);
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
      // 7a/7b: the card spans the column's whole edge (the user bubble's and the composer's), its glyph on the text edge.
      <div data-plan="approved" role="group" aria-label="Approved plan" className="-mx-3 text-sm">
        <Card padding="none">
          <div className="flex items-center">
            <Button variant="quiet" size="md" fullWidth aria-expanded={open} onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 justify-start px-3">
              <Glyph icon={Check} size={14} className="shrink-0 text-ok" />
              <span className="truncate text-left">Plan approved</span>
              <Glyph icon={ChevronRight} size={14} className={cn("shrink-0 text-fg-3 transition-transform duration-base", open && "rotate-90")} />
            </Button>
            {ws && (
              <Button variant="quiet" size="sm" onClick={openInTab} className="mr-1.5 shrink-0">
                <Glyph icon={SquareArrowOutUpRight} size={14} />
                Open in tab
              </Button>
            )}
          </div>
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
      title={shown.title}
      asks="Approve it to start the work"
      className="-mx-3"
      glyph="needs"
      primary={
        <Button variant="primary" size="sm" disabled={busy || running} loading={busy} onClick={() => void approve()}>
          Approve and run
        </Button>
      }
      alternatives={
        <>
          {ws && (
            <Button variant="quiet" size="sm" disabled={busy} onClick={openInTab}>
              <Glyph icon={SquareArrowOutUpRight} size={14} />
              Open in tab
            </Button>
          )}
          <Button variant="quiet" size="sm" disabled={busy} onClick={props.onKeepEditing}>
            Revise in chat
          </Button>
        </>
      }
      error={problem}
    >
      <div className="max-h-80 overflow-y-auto overscroll-contain">
        <LazyMarkdown text={shown.body} className="octo-prose" />
      </div>
      {running && !problem && <p className="text-fg-3">Octo is still working.</p>}
    </RequestCard>
  );
}

/** The newest plan, asked once for all the cards that look (one request per project/session within a second). */
const latest = new Map<string, { at: number; plan: Promise<Plan | null> }>();
function latestPlan(bridge: Bridge, projectId: string, sessionId: string | null): Promise<Plan | null> {
  const key = sessionId ? `${projectId}:${sessionId}` : projectId;
  const hit = latest.get(key);
  if (hit && Date.now() - hit.at < 1000) return hit.plan;
  // null: no plan turn yet. Any failure: plans still arrive as events, and a reload asks again.
  const fetch =
    sessionId && bridge.getSessionLatestPlan ? bridge.getSessionLatestPlan(projectId, sessionId) : (bridge.getLatestPlan?.(projectId) ?? Promise.resolve(null));
  const plan = fetch.catch(() => null);
  latest.set(key, { at: Date.now(), plan });
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
  const scope = useSessionScope();
  const sessionId = scope?.sessionId ?? null;
  const [plan, setPlan] = useState<Plan | null>(null);
  const { turnId } = props;
  const synced = usePlanTab(projectId, plan?.id ?? "");
  const active = synced ?? plan;
  useEffect(() => {
    let alive = true;
    void latestPlan(bridge, projectId, sessionId).then((p) => {
      if (!alive || !p) return;
      setPlanTabState(projectId, p, planTitle(p.text).title);
      if (p.turn_id === turnId) setPlan(p);
    });
    const off = onEvent((e) => {
      if (e.type === "plan.created" || e.type === "plan.approved") {
        setPlanTabState(projectId, e.plan, planTitle(e.plan.text).title);
        if (e.plan.turn_id === turnId) setPlan(e.plan);
      }
      if (e.type === "conversation.rewound") {
        dropPlansFromTurn(projectId, e.message_id);
        if (e.message_id <= turnId) setPlan(null);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge, projectId, sessionId, onEvent, turnId]);
  const refresh = useCallback(async () => {
    const p = sessionId && bridge.getSessionLatestPlan ? await bridge.getSessionLatestPlan(projectId, sessionId) : await bridge.getLatestPlan?.(projectId);
    if (p) {
      setPlanTabState(projectId, p, planTitle(p.text).title);
      if (p.turn_id === turnId) setPlan(p);
    }
  }, [bridge, projectId, sessionId, turnId]);
  return active ? <PlanCard plan={active} onPlan={setPlan} onRefresh={refresh} onKeepEditing={props.onKeepEditing} /> : null;
}
