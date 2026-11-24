import { Check, CircleX } from "lucide-react";
import { ancestorsOf } from "@octo/agent-client";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";

import { formatDuration } from "../../lib/format";
import { useNow, useLatest } from "../../lib/hooks";
import { buildTurns, requestSummaries } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { CHAT } from "../../state/workspace/layout";
import { FloatingBlockContext } from "../../state/workspace/useFloatingHere";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Spinner } from "../primitives/Status";
import { RunningDot } from "../primitives/statusMore";
import { CommentsControl } from "./CommentsControlLazy";
import { Composer } from "./Composer";
import { useOrchestratorComposer } from "./useOrchestratorComposer";

/**
 * The orchestrator composer floating over a file view (or Agents / Notes) while no Chat tab is visible:
 * centred at the bottom of the host, 16px from its bottom and sides, at most 640px wide, with 24px
 * status chips 8px above it — the turn ("Working… 12s", "Worked for 23s", "Turn failed"), running
 * agents and pending comments. A chip focuses Chat (the comments chip opens its list). It shares the
 * Chat composer's draft, model and send path; `onHeight` reports the room it takes (chips included).
 *
 * P9 (polish step 5): over a tool tab (Sessions, Memory, Notes, Usage, Agents, Details, Changes, side question) it rests in
 * its one-line form, the text line and send, so the panel under it stays readable; the status chips, the queue and the
 * composer's own chips show while focus is inside it (or in a menu it opened). Over a file it stays whole, except on a phone-width
 * file bar (`rest`, one strip), where it rests the same way. The room it
 * reports follows the form it is in, so `FloatRoom` keeps the last row clear either way.
 */
/** Menus and popovers the composer opens are portalled out of it: focus inside one still counts as inside the composer. */
/** A focus this soon after Tab was moved by the person. */
const OWN_FOCUS_MS = 500;

const POPUPS = '[role="listbox"], [role="menu"], [role="dialog"]';

export function FloatingComposer({ onHeight, rest = false }: { onHeight?(px: number): void; rest?: boolean }) {
  const ws = useWorkspace();
  const { project, state, running, ensureMessages } = useProject();
  const composer = useOrchestratorComposer(CHAT);
  const root = useRef<HTMLDivElement>(null);
  // Only a tool tab's host provides the forms counter: that is where the composer rests collapsed.
  const overTool = useContext(FloatingBlockContext) !== null;
  const [focused, setFocused] = useState(false);
  // `rest`: a file view on a phone-width bar (one strip) rests it too: the whole form would cover a third of the file.
  const collapsed = (overTool || rest) && !focused;
  // Focus the app hands back by itself (the palette closing, a tab opening) leaves it at rest: only the person's own
  // focus opens it — a press, Tab or Shift+Tab, or typing into the line.
  const tabAt = useRef(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab") tabAt.current = Date.now();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    // The send button keeps its place when pressed in the one-line form (expanding would move it from under the pointer).
    if (e.target instanceof HTMLElement && e.target.closest("[data-composer-row] [data-action]")) return;
    if (document.documentElement.dataset.input === "pointer" || Date.now() - tabAt.current < OWN_FOCUS_MS) setFocused(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (next && (e.currentTarget.contains(next) || next.closest(POPUPS))) return;
    // Focus may be on its way into a menu the composer opens (portalled): look once it has landed.
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body && (root.current?.contains(at) || at.closest(POPUPS))) return;
      setFocused(false);
    });
  };
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
  // This session's agents only (decision 96: another session's work is not this composer's).
  const agentsRunning = state.agentOrder.filter(
    (id) => id !== orchestratorId && state.agents[id]?.status === "running" && (!orchestratorId || ancestorsOf(state, id).some((a) => a.id === orchestratorId)),
  ).length;

  let turn: React.ReactNode = null;
  if (last?.state === "working") {
    turn = (
      <>
        <Spinner size="md" className="text-accent" />
        Working… {formatDuration(now - last.startedAt)}
      </>
    );
  } else if (last?.state === "failed") {
    turn = (
      <>
        <Glyph icon={CircleX} size={14} className="text-err" />
        Request failed
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
  const chips = turn !== null || agentsRunning > 0;

  return (
    <div
      data-floating-composer
      data-collapsed={collapsed || undefined}
      role="region"
      aria-label="Floating composer"
      className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center"
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- focus inside opens the one-line form; nothing here is a control of its own */}
      <div
        ref={root}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={() => setFocused(true)}
        onPointerDown={() => setFocused(true)}
        className="pointer-events-auto w-full max-w-float"
      >
        {chips && !collapsed && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {turn && (
              <Button variant="float" size="xs" className="tabular-nums" onClick={ws.focusChat} title="Show the conversation">
                {turn}
              </Button>
            )}
            {agentsRunning > 0 && (
              <Button variant="float" size="xs" className="tabular-nums" onClick={ws.focusChat} title="Show the conversation">
                <RunningDot />
                {agentsRunning}&nbsp;{agentsRunning === 1 ? "agent" : "agents"} running
              </Button>
            )}
          </div>
        )}
        {/* State changes only (not the ticking timer) are announced. */}
        <p role="status" className="sr-only">
          {last?.state === "working" ? "Working" : last?.state === "failed" ? "Request failed" : last?.state === "done" ? "Done" : ""}
        </p>
        <Composer
          {...composer}
          floating
          comments={
            composer.commentCount + composer.designNoteCount > 0
              ? {
                  count: composer.commentCount + composer.designNoteCount,
                  render: (open: boolean, setOpen: (open: boolean) => void) => <CommentsControl open={open} onOpenChange={setOpen} />,
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
