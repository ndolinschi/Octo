import type { Plan } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorCode, errorMessage } from "../../lib/format";
import { planError } from "../../lib/modeLabels";
import { planTitle } from "../../lib/planTitle";
import { useApp } from "../../state/app";
import { dropPlansFromTurn, setPlanTabState, usePlanTab } from "../../state/planTabs";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { Notice } from "../primitives/Notice";
import { StateGlyph } from "../primitives/StateGlyph";
import { LazyMarkdown } from "./LazyMarkdown";

/**
 * Full-height reading view for a plan opened in its own workspace tab (`plan:<id>`).
 * Lets the user read the entire plan beside the conversation before approving or revising it.
 */
export function PlanTab(props: { planId: string }) {
  const { planId } = props;
  const { bridge } = useApp();
  const { projectId, running, onEvent, state } = useProject();
  const ws = useOptionalWorkspace();
  const plan = usePlanTab(projectId, planId);
  const [fetchedId, setFetchedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const loading = !plan && fetchedId !== planId;

  const loadLatest = useCallback(async () => {
    const candidates: Promise<Plan | null>[] = [];
    if (bridge.getLatestPlan) candidates.push(bridge.getLatestPlan(projectId).catch(() => null));
    const sid = ws?.focusedSessionId ?? ws?.chatSessionId ?? state.sessions.defaultId;
    if (sid && bridge.getSessionLatestPlan) {
      candidates.push(bridge.getSessionLatestPlan(projectId, sid).catch(() => null));
    }
    const results = await Promise.all(candidates);
    for (const p of results) {
      if (p) setPlanTabState(projectId, p, planTitle(p.text).title);
    }
  }, [bridge, projectId, state.sessions.defaultId, ws?.chatSessionId, ws?.focusedSessionId]);

  useEffect(() => {
    let alive = true;
    if (!plan) {
      void loadLatest().finally(() => {
        if (alive) setFetchedId(planId);
      });
    }
    const off = onEvent((e) => {
      if (e.type === "plan.created" || e.type === "plan.approved") {
        setPlanTabState(projectId, e.plan, planTitle(e.plan.text).title);
      }
      if (e.type === "conversation.rewound") {
        dropPlansFromTurn(projectId, e.message_id);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [loadLatest, onEvent, plan, planId, projectId]);

  const approve = async () => {
    if (!plan || !bridge.approvePlan || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.approvePlan(projectId, plan.id);
      setPlanTabState(projectId, result.plan, planTitle(result.plan.text).title);
    } catch (e) {
      const known = planError(errorCode(e));
      if (known?.refresh) await loadLatest().catch(() => undefined);
      setProblem(known?.text ?? `Could not approve the plan: ${errorMessage(e).replace(/\.$/, "")}. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const copyText = async () => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center px-6 text-sm text-fg-3">Loading plan…</div>;
  }

  if (!plan) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-fg-3">
        <p>This plan is no longer available.</p>
        {ws && (
          <Button variant="quiet" size="sm" onClick={() => ws.focusChat()}>
            Back to chat
          </Button>
        )}
      </div>
    );
  }

  const approved = plan.status === "approved";
  const shown = planTitle(plan.text);

  return (
    <div data-plan-tab={plan.status} className="bg-bg flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {approved ? <Glyph icon={Check} size={14} className="shrink-0 text-ok" /> : <StateGlyph state="needs" />}
          <h2 className="min-w-0 truncate text-heading text-fg">{shown.title}</h2>
          <span className="shrink-0 text-xs text-fg-3">{approved ? "Approved" : "Approve it to start the work"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="quiet" size="sm" onClick={() => void copyText()}>
            <Glyph icon={copied ? Check : Copy} size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
          {!approved && (
            <>
              {ws && (
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => ws.focusChat()}>
                  Back to chat
                </Button>
              )}
              <Button variant="primary" size="sm" disabled={busy || running} loading={busy} onClick={() => void approve()}>
                Approve and run
              </Button>
            </>
          )}
        </div>
      </header>
      {problem && (
        <div className="shrink-0 border-b border-line px-4 py-2">
          <Notice tone="error">{problem}</Notice>
        </div>
      )}
      {!approved && running && !problem && <div className="shrink-0 border-b border-line px-4 py-1.5 text-xs text-fg-3">Octo is still working.</div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article className="mx-auto max-w-3xl px-6 py-6">
          <LazyMarkdown text={shown.body} className="octo-prose" />
        </article>
      </div>
    </div>
  );
}
