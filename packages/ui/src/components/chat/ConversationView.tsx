import { useScrollAnchor } from "../../lib/scrollAnchor";
import type { Agent } from "@octo/agent-client";
import { ArrowDown } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";
import { CHAT, type TabId } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { roleName as baseRoleName } from "../../lib/orchestrator";
import { useNav, useNavState } from "../../state/nav";
import { useComposerAnchor } from "./useComposerAnchor";

/** Decision 63: the project's own agent goes by the project's name in its conversation, never "Orchestrator". */
const nameIn = (projectName: string) => (a: Pick<Agent, "parent_id" | "role">) => (a.parent_id === null ? projectName : baseRoleName(a));
import { showRail, turnWarning } from "../../lib/transcript";
import { TurnBanner, useLoginHint } from "./Transcript";

/** A sub-agent's header loads with the first Agent tab (its own chunk). */
const AgentHeader = lazy(() => import("./AgentHeader").then((m) => ({ default: m.AgentHeader })));
import { requestTitle } from "../../lib/comments";
import { buildTurns, promptText, requestSummaries } from "../../lib/transcript";
import { CommentsControl } from "./CommentsControlLazy";
import { Composer, type ComposerHandle } from "./Composer";
import { TurnRail } from "./TurnRail";
import { useOrchestratorComposer } from "./useOrchestratorComposer";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_EMPTY } from "../../lib/streakPresets";
import { useApp } from "../../state/app";
import { ObserverBar } from "./ObserverBar";
import { useBackdrop } from "../primitives/backdrop";
import { StickyPrompt } from "./StickyPrompt";
import { Transcript } from "./Transcript";
import { useStuckTurn, useTurnRequests, useViewTurn } from "./turnTracking";
import { slot } from "../../state/workspace/tabMemory";

type ScrollMemory = { top: number; atBottom: boolean };
const SCROLL_MEMORY = slot(
  "scroll",
  (v): v is ScrollMemory =>
    typeof v === "object" && v !== null && "top" in v && typeof v.top === "number" && "atBottom" in v && typeof v.atBottom === "boolean",
);

/** A row outside the scroll area with the scroll area's gutters and side padding (see the doc comment). */
export const EDGES = "scroll-quiet overflow-hidden px-(--pad)";

/** The empty project's title and facts load when an empty project shows (their own chunk; the composer is not in it). */
const EmptyTitle = lazy(() => import("./EmptyProject").then((m) => ({ default: m.EmptyTitle })));
const EmptyFacts = lazy(() => import("./EmptyProject").then((m) => ({ default: m.EmptyFacts })));

/** The turn rail appears from the first request (decision 34). */

/**
 * A conversation (the orchestrator's Chat tab or a sub-agent's Agent tab). The header, transcript
 * column, pinned prompt, rail, jump button and composer / read-only bar share both edges exactly: the
 * scroll area reserves its scrollbar gutter on both sides (`scroll-quiet`), and every row outside it
 * reserves the same gutter the same way (`EDGES`: `overflow: hidden` + the same `scrollbar-gutter`),
 * then all of them pad by `--pad` (24, or 16 under 560px). Rhythm: turns 32 apart, prompt → reply 16,
 * blocks 12.
 */
export function ConversationView({ agentId, tab = CHAT }: { agentId: string; tab?: TabId }) {
  const ws = useOptionalWorkspace();
  const { theme, backdrop: appBackdrop } = useApp();
  const { project, state, running, ensureMessages, projectId } = useProject();
  const agent = state.agents[agentId];
  const messages = state.messages[agentId];
  const streaming = state.streaming[agentId];
  const composer = useRef<ComposerHandle>(null);
  const isOrchestrator = agent?.parent_id === null;
  const composerProps = useOrchestratorComposer(tab);
  const anyRunning = state.agentOrder.some((id) => state.agents[id]?.status === "running");
  const now = useNow(anyRunning);
  const memory = ws?.memory;
  const saved = memory?.get(tab, SCROLL_MEMORY);
  const scroll = useStickToBottom<HTMLDivElement>(
    [messages, streaming, agent?.status, agentId],
    saved ? saved.atBottom : isOrchestrator || agent?.status === "running",
  );

  // The scroll area's visible height: the turn rail never grows past it.
  const [scrollHeight, setScrollHeight] = useState(0);
  const sized = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (sized.current?.el === el) return;
    sized.current?.ro.disconnect();
    sized.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Hidden (background tab): keep the last size.
      if (el.clientHeight > 0) setScrollHeight(el.clientHeight);
    });
    ro.observe(el);
    sized.current = { el, ro };
    if (el.clientHeight > 0) setScrollHeight(el.clientHeight);
  });
  useEffect(() => () => sized.current?.ro.disconnect(), []);

  // A conversation kept alive in a background tab returns to the end when shown again (if it was there).
  const shown = ws ? ws.isVisible(tab) : true;
  const { restick } = scroll;
  useLayoutEffect(() => {
    if (shown) restick();
  }, [shown, restick]);

  const stuck = useStuckTurn(scroll.ref);
  const promptCount = useMemo(() => messages?.filter((m) => m.role === "user").length ?? 0, [messages]);
  const lastTurnStatus = isOrchestrator ? (state.lastTurn?.status ?? null) : null;
  const requests = useMemo(
    () => (isOrchestrator && messages ? requestSummaries(buildTurns(messages), agent?.status === "running", lastTurnStatus) : []),
    [isOrchestrator, messages, agent?.status, lastTurnStatus],
  );
  useViewTurn(scroll.ref, projectId, isOrchestrator, promptCount);
  useTurnRequests({
    root: scroll.ref,
    projectId,
    enabled: isOrchestrator,
    loaded: messages !== undefined,
    release: scroll.release,
    reveal: ws ? () => ws.activate(tab) : undefined,
  });
  const { onScroll: measureStuck } = stuck;
  useEffect(measureStuck, [messages, streaming, measureStuck]);
  // Decision 56: "Jump to latest" hides while a popover of the composer is open.
  const [overlay, setOverlay] = useState(false);
  const composerRow = useRef<HTMLDivElement>(null);
  useComposerAnchor(scroll.ref, composerRow, scroll.atBottom);
  const nav = useNav();
  const { viewTurn } = useNavState();
  // Decision 57: Alt+↑/↓ anywhere in the conversation jumps between requests.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || requests.length === 0) return;
    const at = viewTurn?.projectId === projectId ? requests.findIndex((r) => r.id === viewTurn.messageId) : -1;
    const to = at < 0 ? requests.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    const target = requests[Math.max(0, Math.min(requests.length - 1, to))];
    if (!target) return;
    e.preventDefault();
    nav.requestTurn({ projectId, messageId: target.id });
  };

  // The empty project's streak runs behind the whole group (strip and header too), not only this view.
  const backdrop = useBackdrop();
  const emptyNow = isOrchestrator && messages !== undefined && messages.length === 0 && !running;
  useEffect(() => {
    if (!backdrop) return;
    backdrop.set(tab, emptyNow);
    return () => backdrop.set(tab, false);
  }, [backdrop, tab, emptyNow]);

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

  // Moving a tab remounts it: put the reader back where they were.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (restored.current || !el || messages === undefined) return;
    restored.current = true;
    // Read now, not at render: the instance this one replaces saves its position in its cleanup, which runs in the
    // same commit after this render (a moved tab).
    const at = memory?.get(tab, SCROLL_MEMORY);
    if (at && !at.atBottom) {
      scroll.release();
      el.scrollTop = at.top;
    }
  }, [messages, memory, tab, scroll]);
  // Opening a file narrows the conversation and the text re-wraps: keep the reader's place (decision 60). The scroller only
  // exists once there are messages, so the tracker is bound again when that changes.
  useScrollAnchor(scroll.ref, "article, article :is(p, li, pre, h1, h2, h3, h4, blockquote, tr)", messages === undefined ? 0 : messages.length === 0 ? 1 : 2);
  // Saved on unmount from the scroller as it is then — it may have appeared after mount (a project that started
  // empty: decision 36), so the element is read at cleanup, before the DOM goes.
  useLayoutEffect(() => {
    const ref = scroll.ref;
    return () => {
      const el = ref.current;
      if (el && memory) memory.set(tab, SCROLL_MEMORY, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 });
    };
  }, [memory, tab, scroll.ref]);

  if (!project) return null;
  const roleName = nameIn(project.name);
  if (!agent) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <p className="text-sm text-fg-2">This agent isn't part of {project.name}.</p>
          <a href={hrefFor(projectId)} className="mt-2 inline-block text-sm text-fg underline underline-offset-2">
            Back to orchestrator
          </a>
        </div>
      </div>
    );
  }

  const parent = agent.parent_id ? state.agents[agent.parent_id] : undefined;
  const loadedEmpty = messages !== undefined && messages.length === 0;
  const showStarters = isOrchestrator && loadedEmpty && !running;
  const stuckPrompt = stuck.stuckId !== null ? messages?.find((m) => m.id === stuck.stuckId) : undefined;
  const watched = ws ? ws.watched === tab : true;

  const empty = showStarters;
  const commentsSlot = composerProps.commentCount
    ? { count: composerProps.commentCount, render: (open: boolean, setOpen: (open: boolean) => void) => <CommentsControl open={open} onOpenChange={setOpen} /> }
    : undefined;

  // One tree for both layouts (contract v6 decision 13, v6.2 race fix): the header, the middle (the empty
  // project's title or the transcript), the composer row and the empty project's facts keep their positions, so
  // the composer is ONE element that never remounts — a new project's composer keeps focus and draft when its
  // messages arrive. The empty project centres title + composer + facts between two flexible halves.
  return (
    <div
      data-conv
      onKeyDown={onKeyDown}
      className={cn(
        "@container/conv relative flex h-full min-h-0 flex-col [--pad:24px] @max-[560px]/conv:[--pad:16px]",
        // Decision 50: the empty project's streak is on the dock group (never in this scroller); no rubber-band either.
        empty && "overflow-x-hidden overflow-y-auto overscroll-none",
      )}
    >
      {empty ? (
        <div data-empty-project className="flex flex-[1_0_auto] flex-col justify-end px-(--pad) pt-8 pb-6">
          {!backdrop && appBackdrop !== "off" && <StreakLayer preset={STREAK_EMPTY} theme={theme} mono={appBackdrop === "mono"} />}
          <Suspense fallback={null}>
            <EmptyTitle project={project} />
          </Suspense>
          <StartFailure agent={agent} />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {stuckPrompt && (
            <StickyPrompt
              key={stuckPrompt.id}
              text={requestTitle(promptText(stuckPrompt))}
              author={isOrchestrator ? null : parent ? roleName(parent) : "Parent"}
              onHeight={stuck.setPinnedHeight}
            />
          )}
          {showRail(requests.length) && (
            // The rail sits in the column's left padding, 4px clear of it; hidden when the padding is 16. The
            // layer covers the whole scroll area (it clips like the transcript) but takes no pointer events.
            <div className={cn(EDGES, "pointer-events-none absolute inset-x-0 top-0 z-20 @max-[560px]/conv:hidden")} style={{ height: scrollHeight }}>
              {/* Decision 57: centred vertically in the conversation's viewport; it takes no layout width. */}
              <div className="relative mx-auto h-full max-w-measure">
                <div className="pointer-events-auto absolute top-1/2 right-full mr-3 -translate-y-1/2">
                  <TurnRail requests={requests} projectId={projectId} now={now} maxHeight={scrollHeight - 16} />
                </div>
              </div>
            </div>
          )}
          <div
            ref={scroll.ref}
            onScroll={() => {
              scroll.onScroll();
              stuck.onScroll();
            }}
            className="min-h-0 flex-1 overflow-y-auto scroll-quiet"
          >
            <div className="px-(--pad)">
              <div data-column className="mx-auto w-full max-w-measure pt-2 pb-8">
                {!isOrchestrator && (
                  <Suspense fallback={<div className="mb-5 h-12" aria-hidden />}>
                    <AgentHeader agent={agent} now={now} />
                  </Suspense>
                )}
                <Transcript
                  agent={agent}
                  messages={messages ?? []}
                  now={now}
                  watched={watched}
                  speaker={roleName(agent)}
                  promptAuthor={isOrchestrator ? "You" : parent ? roleName(parent) : "Parent"}
                  hideFirstPrompt={!isOrchestrator}
                />
              </div>
            </div>
          </div>
          {!scroll.atBottom && !overlay && (
            // Scrolled up, the view ends 40px higher: the button gets its own room below the transcript
            // (4 + 32 + 4), so it never sits on text, and the last 12px of text fade out above that room.
            // The content does not move (the scroll position is kept); at the bottom the room goes again.
            <div data-jump-room className="relative flex h-10 shrink-0 items-center justify-center">
              <div aria-hidden className="octo-fade pointer-events-none absolute inset-x-0 -top-3 h-3 overflow-hidden scroll-quiet">
                <div className="h-full bg-linear-to-t from-panel to-transparent" />
              </div>
              <button
                type="button"
                onClick={() => scroll.scrollToBottom(true)}
                aria-label="Jump to latest"
                title="Jump to latest"
                className="octo-fade octo-ring-pop grid size-8 press place-items-center rounded-full border border-line-strong bg-overlay text-fg-2 shadow-pop hover:text-fg"
              >
                <Glyph icon={ArrowDown} size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={composerRow} className={cn(EDGES, "relative shrink-0", !empty && "pt-2 pb-3")}>
        <div data-column-edge className={cn("mx-auto w-full", empty ? "max-w-float" : "max-w-measure")}>
          {isOrchestrator ? <Composer ref={composer} {...composerProps} comments={commentsSlot} onOverlay={setOverlay} /> : <ObserverBar />}
        </div>
      </div>
      {empty && (
        <div className="relative flex-[1_0_auto] px-(--pad) pt-4 pb-8">
          <Suspense fallback={null}>
            <EmptyFacts project={project} onPick={(text) => composer.current?.fill(text)} />
          </Suspense>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {agent.status === "running" ? `${roleName(agent)} is working` : ""}
      </p>
    </div>
  );
}

/**
 * The orchestrator failed before anything was stored (an ACP agent that is not logged in): the failed turn shows above
 * the empty project's composer with its message and the agent's login hint — never a silent "Idle".
 */
function StartFailure({ agent }: { agent: Agent }) {
  const { state } = useProject();
  const failed =
    state.lastTurn?.status === "failed"
      ? state.lastTurn.error
      : agent.status === "failed" || (agent.error && !turnWarning(agent.error))
        ? agent.error
        : undefined;
  const hint = useLoginHint(failed !== undefined ? agent.model : null);
  if (failed === undefined || agent.status === "running") return null;
  return (
    <div data-start-failure className="relative mx-auto mt-4 w-full max-w-float">
      <TurnBanner status="failed" error={failed} retryText={null} hint={hint} />
    </div>
  );
}
