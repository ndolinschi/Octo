import { useScrollAnchor } from "../../lib/scrollAnchor";
import type { Agent } from "@octo/agent-client";
import { ArrowDown } from "lucide-react";
import { IconButton } from "../primitives/IconButton";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { InlineNotesProvider } from "./notesContext";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useChatSlots } from "../../state/chatSlots";
import { useProject } from "../../state/project";
import { CHAT, type TabId } from "../../state/workspace/layout";
import { useSessionScope } from "../../state/session";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { roleName as baseRoleName } from "../../lib/orchestrator";
import { useNav, useNavState } from "../../state/nav";
import { useComposerAnchor } from "./useComposerAnchor";
const Announcer = lazy(() => import("./Announcer").then((m) => ({ default: m.Announcer })));

/** Decision 63: the project's own agent goes by the project's name in its conversation, never "Orchestrator". */
const nameIn = (projectName: string) => (a: Pick<Agent, "parent_id" | "role">) => (a.parent_id === null ? projectName : baseRoleName(a));
import { showRail } from "../../lib/transcript";
/** The failed start of an empty project (rare): its own chunk. */
const LoadFailed = lazy(() => import("./LoadFailed").then((m) => ({ default: m.LoadFailed })));
const StartFailure = lazy(() => import("./StartFailure").then((m) => ({ default: m.StartFailure })));

/** A sub-agent's header loads with the first Agent tab (its own chunk). */
const AgentHeader = lazy(() => import("./AgentHeader").then((m) => ({ default: m.AgentHeader })));
import { requestTitle } from "../../lib/comments";
import { buildTurns, promptText, requestSummaries } from "../../lib/transcript";
import { CommentsControl } from "./CommentsControlLazy";
import { Composer, type ComposerHandle } from "./Composer";
const InlineNotes = lazy(() => import("./InlineNotes").then((m) => ({ default: m.InlineNotes })));
const TurnRail = lazy(() => import("./TurnRail").then((m) => ({ default: m.TurnRail })));
import { useOrchestratorComposer } from "./useOrchestratorComposer";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_EMPTY } from "../../lib/streakPresets";
import { useApp } from "../../state/app";
/** An Agent tab's read-only bar loads with the first Agent tab, like its header (a 40px placeholder keeps the row's height). */
const ObserverBar = lazy(() => import("./ObserverBar").then((m) => ({ default: m.ObserverBar })));
import { useBackdrop } from "../primitives/backdrop";
const StickyPrompt = lazy(() => import("./StickyPrompt").then((m) => ({ default: m.StickyPrompt })));
import { transcriptPart } from "./transcriptPart";
const Transcript = transcriptPart.Component;
import { Presence } from "../primitives/Presence";

/** The rewind dialog loads when first asked for (parity B5). */
const RewindDialog = lazy(() => import("./RewindDialog").then((m) => ({ default: m.RewindDialog })));
import { useStuckTurn, useTurnRequests, useViewTurn } from "./turnTracking";
import { slot } from "../../state/workspace/tabMemory";
import { restoreScrollWhenReachable, useScrollSpot } from "./useScrollSpot";

type ScrollMemory = { top: number; atBottom: boolean };
const SCROLL_MEMORY = slot(
  "scroll",
  (v): v is ScrollMemory =>
    typeof v === "object" && v !== null && "top" in v && typeof v.top === "number" && "atBottom" in v && typeof v.atBottom === "boolean",
);

/** A row outside the scroll area with the scroll area's gutters and side padding (see the doc comment). */
export const EDGES = "scroll-quiet overflow-hidden px-(--pad)";

/** The empty project's title loads when an empty project shows (its own chunk; the composer is not in it). */
const EmptyTitle = lazy(() => import("./EmptyProject").then((m) => ({ default: m.EmptyTitle })));
/** The agy-style inline project selector loads only on empty sessions (kept out of the initial bundle). */
const ComposerProjectBar = lazy(() => import("./ComposerProjectBar").then((m) => ({ default: m.ComposerProjectBar })));

/** The turn rail appears from the first request (decision 34). */

/**
 * A conversation (the orchestrator's Chat tab or a sub-agent's Agent tab). The header, transcript
 * column, pinned prompt, rail, jump button and composer / read-only bar share both edges exactly: the
 * scroll area reserves its scrollbar gutter on both sides (`scroll-quiet`), and every row outside it
 * reserves the same gutter the same way (`EDGES`: `overflow: hidden` + the same `scrollbar-gutter`),
 * then all of them pad by `--pad` (24, or 16 under 560px). Rhythm: turns 32 apart, prompt → reply 16,
 * blocks 12.
 */
/** Owns the notes slash commands leave in the conversation (B11); `/rewind` reaches the body's dialog through a ref. */
export function ConversationView(props: { agentId: string; tab?: TabId }) {
  const rewindRef = useRef<(() => void) | undefined>(undefined);
  const rewindLast = useCallback(() => rewindRef.current?.(), []);
  return (
    <InlineNotesProvider rewindLast={rewindLast}>
      <ConversationBody {...props} rewindRef={rewindRef} />
    </InlineNotesProvider>
  );
}

function ConversationBody({ agentId, tab = CHAT, rewindRef }: { agentId: string; tab?: TabId; rewindRef: { current: (() => void) | undefined } }) {
  const ws = useOptionalWorkspace();
  const slots = useChatSlots();
  const { theme, backdrop: appBackdrop, bridge, projects } = useApp();
  const { project, state, running, ensureMessages, projectId, loadFailures, reload } = useProject();
  const agent = state.agents[agentId];
  const messages = state.messages[agentId];
  const hasStreaming = (state.streaming[agentId]?.length ?? 0) > 0;
  const composer = useRef<ComposerHandle>(null);
  const isOrchestrator = agent?.parent_id === null;
  const composerProps = useOrchestratorComposer(tab);
  // R2 checkpoints: the request a restore cuts, and whether it is the one after a reply ("Restore to here") or `/rewind`'s newest.
  const [rewinding, setRewinding] = useState<{ id: number; which: "next" | "this" } | null>(null);
  const restoreTo = useCallback((id: number) => setRewinding({ id, which: "next" }), []);
  const keepEditing = useCallback(() => composer.current?.refinePlan(), []);
  // Conversation-level relative labels update per minute; active 1s timers are localized inside ActivityLine, AgentHeader, and DelegationRow.
  const now = useNow(true, CLOCK_MINUTE_MS);
  const memory = ws?.memory;
  // Decision 96: where the reader was is the session's own (Chat shows one session after another).
  const spot = useSessionScope()?.memoryKey ?? tab;
  const spotStore = useScrollSpot(projectId, spot);
  const saved = memory?.get(spot, SCROLL_MEMORY) ?? spotStore.stored;
  const scroll = useStickToBottom<HTMLDivElement>(
    [messages, hasStreaming, agent?.status, agentId],
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
  // Sending always shows the sent message and follows from there: a reader who had scrolled up goes down to it (rule:
  // `scroll-on-send.mjs`). The first load of the transcript and a rewind (fewer requests) do not count as sending.
  const seenPrompts = useRef<number | null>(null);
  const { scrollToBottom } = scroll;
  useLayoutEffect(() => {
    if (!isOrchestrator || messages === undefined) return;
    const before = seenPrompts.current;
    seenPrompts.current = promptCount;
    if (before !== null && promptCount > before) scrollToBottom(true);
  }, [isOrchestrator, messages, promptCount, scrollToBottom]);
  const lastTurnStatus = isOrchestrator ? (state.lastTurn?.status ?? null) : null;
  const requests = useMemo(
    () => (isOrchestrator && messages ? requestSummaries(buildTurns(messages), agent?.status === "running", lastTurnStatus) : []),
    [isOrchestrator, messages, agent?.status, lastTurnStatus],
  );
  const newestRequest = requests[requests.length - 1]?.id;
  useEffect(() => {
    rewindRef.current = newestRequest === undefined ? undefined : () => setRewinding({ id: newestRequest, which: "this" });
    return () => {
      rewindRef.current = undefined;
    };
  }, [rewindRef, newestRequest]);
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
  useEffect(measureStuck, [messages, hasStreaming, measureStuck]);
  // Decision 56: "Jump to latest" hides while a popover of the composer or its inline project bar is open.
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
  const cancelRestore = useRef(() => {});
  useEffect(() => () => cancelRestore.current(), []);
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (restored.current || !el || messages === undefined) return;
    restored.current = true;
    // Read now, not at render: the instance this one replaces saves its position in its cleanup, which runs in the
    // same commit after this render (a moved tab).
    const at = memory?.get(spot, SCROLL_MEMORY) ?? spotStore.stored;
    if (at && !at.atBottom) {
      scroll.release();
      // After a reload the transcript is still short: wait until the saved offset exists, or the clamp reads as "at the end".
      cancelRestore.current = restoreScrollWhenReachable(el, at.top, scroll.release);
    }
  }, [messages, memory, spot, scroll, spotStore.stored]);
  // Opening a file narrows the conversation and the text re-wraps: keep the reader's place (decision 60). The scroller only
  // exists once there are messages, so the tracker is bound again when that changes.
  useScrollAnchor(scroll.ref, "article, article :is(p, li, pre, h1, h2, h3, h4, blockquote, tr)", messages === undefined ? 0 : messages.length === 0 ? 1 : 2);
  // Saved on unmount from the scroller as it is then — it may have appeared after mount (a project that started
  // empty: decision 36), so the element is read at cleanup, before the DOM goes.
  useLayoutEffect(() => {
    const ref = scroll.ref;
    return () => {
      const el = ref.current;
      // A view with nothing to scroll (the loading state of a reload) knows nothing about the reader: do not let it hide the saved spot.
      if (el && memory && el.scrollHeight > el.clientHeight)
        memory.set(spot, SCROLL_MEMORY, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 });
    };
  }, [memory, spot, scroll.ref]);

  // A14: a first load that fails says so, with Retry, while it is retried with backoff. (The project itself failing is
  // `ProjectWorkspace`'s notice.)
  const failure = messages === undefined ? loadFailures[agentId] : undefined;
  if (!project) return null;
  const roleName = nameIn(project.name);
  if (!agent) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyState
          title="Agent not found"
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (ws) ws.focusChat();
                else window.location.hash = hrefFor(projectId);
              }}
            >
              Back to session
            </Button>
          }
        >
          This agent isn&apos;t part of {project.name}.
        </EmptyState>
      </div>
    );
  }

  const parent = agent.parent_id ? state.agents[agent.parent_id] : undefined;
  const loadedEmpty = messages !== undefined && messages.length === 0;
  const showStarters = isOrchestrator && loadedEmpty && !running;
  const stuckPrompt = stuck.stuckId !== null ? messages?.find((m) => m.id === stuck.stuckId) : undefined;
  const watched = ws ? ws.watched === tab : true;

  const empty = showStarters;
  const showProjectBar = empty && !!projects?.length;
  const totalNotes = composerProps.commentCount + composerProps.designNoteCount;
  const commentsSlot = totalNotes
    ? { count: totalNotes, render: (open: boolean, setOpen: (open: boolean) => void) => <CommentsControl open={open} onOpenChange={setOpen} /> }
    : undefined;

  // One tree for both layouts (contract v6 decision 13, v6.2 race fix): the header, the middle (the empty
  // project's title or the transcript), the composer row and the empty project's facts keep their positions, so
  // the composer is ONE element that never remounts — a new project's composer keeps focus and draft when its
  // messages arrive. The empty project centres title + composer + facts between two flexible halves.
  return (
    <div
      data-conv
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (isOrchestrator && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        // Files dropped on the conversation go to the composer, as if dropped on it (B12).
        if (!isOrchestrator || e.defaultPrevented || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        composer.current?.addFiles([...e.dataTransfer.files]);
      }}
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
          <Suspense fallback={null}>
            <StartFailure agent={agent} />
          </Suspense>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {stuckPrompt && (
            <Suspense fallback={null}>
              <StickyPrompt
                key={stuckPrompt.id}
                text={requestTitle(promptText(stuckPrompt))}
                author={isOrchestrator ? null : parent ? roleName(parent) : "Parent"}
                onHeight={stuck.setPinnedHeight}
              />
            </Suspense>
          )}
          {showRail(requests.length) && (
            // The rail sits in the column's left padding, 4px clear of it; hidden when the padding is 16. The
            // layer covers the whole scroll area (it clips like the transcript) but takes no pointer events.
            <div className={cn(EDGES, "pointer-events-none absolute inset-x-0 top-0 z-20 @max-[560px]/conv:hidden")} style={{ height: scrollHeight }}>
              {/* Decision 57: centred vertically in the conversation's viewport; it takes no layout width. */}
              <div className="relative mx-auto h-full max-w-measure">
                <div className="pointer-events-auto absolute top-1/2 right-full mr-3 -translate-y-1/2">
                  <Suspense fallback={null}>
                    <TurnRail requests={requests} projectId={projectId} now={now} maxHeight={scrollHeight - 16} />
                  </Suspense>
                </div>
              </div>
            </div>
          )}
          <div
            ref={scroll.ref}
            onScroll={(e) => {
              scroll.onScroll();
              spotStore.onScroll(e.currentTarget);
              stuck.onScroll();
            }}
            className="min-h-0 flex-1 overflow-y-auto scroll-quiet"
          >
            <div className="px-(--pad)">
              <div data-column className="mx-auto w-full max-w-measure px-3 pt-2 pb-8">
                {!isOrchestrator && (
                  <Suspense fallback={<div className="mb-5 h-12" aria-hidden />}>
                    <AgentHeader agent={agent} />
                  </Suspense>
                )}
                {failure && (
                  <Suspense fallback={null}>
                    <LoadFailed error={failure} onRetry={() => void reload()} />
                  </Suspense>
                )}
                <Suspense fallback={null}>
                  <Transcript
                    agent={agent}
                    messages={messages ?? []}
                    loaded={messages !== undefined}
                    now={now}
                    watched={watched}
                    speaker={agent?.parent_id === null ? (project?.name ?? "Assistant") : roleName(agent)}
                    promptAuthor={isOrchestrator ? "You" : parent ? (parent.parent_id === null ? (project?.name ?? "Assistant") : roleName(parent)) : "Parent"}
                    hideFirstPrompt={!isOrchestrator}
                    onKeepEditing={isOrchestrator ? keepEditing : undefined}
                    onRewind={isOrchestrator && bridge.rewind ? restoreTo : undefined}
                  />
                </Suspense>
                {isOrchestrator && (
                  <Suspense fallback={null}>
                    <InlineNotes />
                  </Suspense>
                )}
                {isOrchestrator && slots?.approvals?.({ onOpenAgent: (id) => ws?.openAgent(id) })}
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
              <IconButton
                icon={ArrowDown}
                label="Jump to latest"
                variant="round"
                size="md"
                className="octo-fade octo-ring-pop shadow-pop"
                onClick={() => scroll.scrollToBottom(true)}
              />
            </div>
          )}
        </div>
      )}

      <div ref={composerRow} className={cn(EDGES, "relative shrink-0", !empty && "pt-2 pb-3")}>
        <div data-column-edge className={cn("mx-auto w-full", empty ? "max-w-float" : "max-w-measure")}>
          {isOrchestrator ? (
            <div data-composer-shell={showProjectBar || undefined} className={cn(showProjectBar && "octo-composer-shell p-0.5")}>
              {showProjectBar && (
                <Suspense fallback={<div className="h-8 px-1.5" aria-hidden />}>
                  <ComposerProjectBar project={project} projects={projects} draft={composerProps.draft} onOverlay={setOverlay} />
                </Suspense>
              )}
              <Composer ref={composer} {...composerProps} comments={commentsSlot} onOverlay={setOverlay} />
            </div>
          ) : (
            <Suspense fallback={<div className="h-bar" />}>
              <ObserverBar />
            </Suspense>
          )}
        </div>
      </div>
      {empty && <div aria-hidden className="relative flex-[1_0_auto] px-(--pad) pt-4 pb-8" />}

      <Presence show={rewinding !== null}>
        {rewinding !== null && (
          <Suspense fallback={null}>
            <RewindDialog
              messageId={rewinding.id}
              which={rewinding.which}
              onClose={() => setRewinding(null)}
              onDone={(report) => {
                setRewinding(null);
                // The request goes back into the box to be edited and sent again.
                composer.current?.fill(report.request_text);
              }}
            />
          </Suspense>
        )}
      </Presence>

      <Suspense fallback={null}>
        <Announcer agent={agent} name={roleName(agent)} project={project.name} orchestrator={isOrchestrator} />
      </Suspense>
    </div>
  );
}
