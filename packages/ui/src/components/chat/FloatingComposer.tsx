import { Check, CircleX } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatDuration } from "../../lib/format";
import { useNow, useLatest } from "../../lib/hooks";
import { buildTurns, requestSummaries } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { CHAT, focusedGroup, type TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { RunningDot, Spinner } from "../primitives/Status";
import { CommentsControl } from "./CommentsControl";
import { Composer } from "./Composer";
import { useOrchestratorComposer } from "./useOrchestratorComposer";

/** True for the tab that hosts the floating composer: the focused group's active tab while no Chat tab is visible. */
export function useFloatingHere(tab: TabId): boolean {
  const ws = useWorkspace();
  return focusedGroup(ws.layout).active === tab && !ws.isVisible(CHAT);
}

const CHIP =
  "press flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-overlay px-2 text-xs text-fg-2 tabular-nums shadow-float octo-ring-float hover:text-fg";

/**
 * The orchestrator composer floating over a file view (or Agents / Notes) while no Chat tab is visible:
 * centred at the bottom of the host, 16px from its bottom and sides, at most 640px wide, with 24px
 * status chips 8px above it — the turn ("Working… 12s", "Worked for 23s", "Turn failed"), running
 * agents and pending comments. A chip focuses Chat (the comments chip opens its list). It shares the
 * Chat composer's draft, model and send path; `onHeight` reports the room it takes (chips included).
 */
export function FloatingComposer({ onHeight }: { onHeight?(px: number): void }) {
  const ws = useWorkspace();
  const { project, state, running, ensureMessages } = useProject();
  const composer = useOrchestratorComposer(CHAT);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const orchestratorId = project?.orchestrator_agent_id;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  const now = useNow(running);

  useEffect(() => {
    if (orchestratorId) ensureMessages(orchestratorId);
  }, [orchestratorId, ensureMessages]);

  const onHeightRef = useLatest(onHeight);
  const report = useCallback((px: number) => onHeightRef.current?.(px), [onHeightRef]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => report(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => {
      ro.disconnect();
      report(0);
    };
  }, [report]);

  const last = useMemo(() => {
    if (!messages) return null;
    const list = requestSummaries(buildTurns(messages), running, state.lastTurn?.status ?? null);
    return list[list.length - 1] ?? null;
  }, [messages, running, state.lastTurn?.status]);
  const agentsRunning = state.agentOrder.filter((id) => id !== orchestratorId && state.agents[id]?.status === "running").length;

  let turn: React.ReactNode = null;
  if (last?.state === "working") {
    turn = (
      <>
        <Spinner size={12} className="text-accent" />
        Working… {formatDuration(now - last.startedAt)}
      </>
    );
  } else if (last?.state === "failed") {
    turn = (
      <>
        <Glyph icon={CircleX} size={14} className="text-err" />
        Turn failed
      </>
    );
  } else if (last?.state === "done" && last.endedAt !== null && last.endedAt - last.startedAt >= 1000) {
    turn = (
      <>
        <Glyph icon={Check} size={14} className="text-ok" />
        Worked for {formatDuration(last.endedAt - last.startedAt)}
      </>
    );
  }
  const chips = turn !== null || agentsRunning > 0 || composer.commentCount > 0;

  return (
    <div
      data-floating-composer
      role="region"
      aria-label="Floating composer"
      className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center"
    >
      <div ref={root} className="pointer-events-auto w-full max-w-float">
        {chips && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {turn && (
              <button type="button" className={CHIP} onClick={ws.focusChat} title="Show the conversation">
                {turn}
              </button>
            )}
            {agentsRunning > 0 && (
              <button type="button" className={CHIP} onClick={ws.focusChat} title="Show the conversation">
                <RunningDot />
                {agentsRunning}&nbsp;{agentsRunning === 1 ? "agent" : "agents"} running
              </button>
            )}
            {composer.commentCount > 0 && <CommentsControl variant="chip" open={commentsOpen} onOpenChange={setCommentsOpen} />}
          </div>
        )}
        {/* State changes only (not the ticking timer) are announced. */}
        <p role="status" className="sr-only">
          {last?.state === "working" ? "The orchestrator is working" : last?.state === "failed" ? "Turn failed" : last?.state === "done" ? "Turn finished" : ""}
        </p>
        <Composer
          {...composer}
          floating
          comments={composer.commentCount ? { count: composer.commentCount, render: () => null } : undefined}
          onOpenComments={() => setCommentsOpen(true)}
        />
      </div>
    </div>
  );
}
