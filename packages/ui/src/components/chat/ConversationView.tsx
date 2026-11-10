import { ArrowDown } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";
import { CHAT } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { AgentHeader, roleName } from "./AgentHeader";
import { requestTitle } from "../../lib/comments";
import { buildTurns, promptText, requestSummaries } from "../../lib/transcript";
import { ChatHeader } from "./ChatHeader";
import { CommentsControl } from "./CommentsControl";
import { Composer, type ComposerHandle } from "./Composer";
import { TurnRail } from "./TurnRail";
import { useOrchestratorComposer } from "./useOrchestratorComposer";
import { StreakLayer } from "../primitives/StreakLayer";
import { useApp } from "../../state/app";
import { ObserverBar } from "./ObserverBar";
import { StarterPrompts } from "./StarterPrompts";
import { StickyPrompt } from "./StickyPrompt";
import { Transcript } from "./Transcript";
import { useStuckTurn, useTurnRequests, useViewTurn } from "./turnTracking";

type ScrollMemory = { top: number; atBottom: boolean };

/** A row outside the scroll area with the scroll area's gutters and side padding (see the doc comment). */
export const EDGES = "scroll-quiet overflow-hidden px-(--pad)";

/** The empty project's streak passes behind the title block (upper middle of the view). */
const EMPTY_STREAK = { x: 0.5, y: 0.3 } as const;
/** The turn rail appears from this many requests on. */
const RAIL_MIN_REQUESTS = 3;

/**
 * A conversation (the orchestrator's Chat tab or a sub-agent's Agent tab). The header, transcript
 * column, pinned prompt, rail, jump button and composer / read-only bar share both edges exactly: the
 * scroll area reserves its scrollbar gutter on both sides (`scroll-quiet`), and every row outside it
 * reserves the same gutter the same way (`EDGES`: `overflow: hidden` + the same `scrollbar-gutter`),
 * then all of them pad by `--pad` (24, or 16 under 560px). Rhythm: turns 32 apart, prompt → reply 16,
 * blocks 12.
 */
export function ConversationView({ agentId, tab = CHAT }: { agentId: string; tab?: string }) {
  const ws = useOptionalWorkspace();
  const { theme } = useApp();
  const { project, state, running, ensureMessages, projectId } = useProject();
  const agent = state.agents[agentId];
  const messages = state.messages[agentId];
  const streaming = state.streaming[agentId];
  const composer = useRef<ComposerHandle>(null);
  const isOrchestrator = agent?.parent_id === null;
  const composerProps = useOrchestratorComposer(`${tab}:draft`);
  const anyRunning = state.agentOrder.some((id) => state.agents[id]?.status === "running");
  const now = useNow(anyRunning);
  const memory = ws?.memory;
  const saved = memory?.get(`${tab}:scroll`) as ScrollMemory | undefined;
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

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

  // Moving a tab remounts it: put the reader back where they were.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (restored.current || !el || messages === undefined) return;
    restored.current = true;
    if (saved && !saved.atBottom) {
      scroll.release();
      el.scrollTop = saved.top;
    }
  }, [messages, saved, scroll]);
  useEffect(() => {
    const el = scroll.ref.current;
    return () => {
      if (el && memory) memory.set(`${tab}:scroll`, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 });
    };
  }, [memory, tab, scroll.ref]);

  if (!project) return null;
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

  if (showStarters) {
    // Empty project (contract v6 decision 13): one centred block over the glow — title, one line, the
    // composer, starter rows. The first message switches to the normal layout (no transition).
    return (
      <div className="@container/conv relative flex h-full min-h-0 flex-col [--pad:24px] @max-[560px]/conv:[--pad:16px]">
        <ChatHeader requests={requests} />
        <div data-empty-project className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-(--pad)">
          <StreakLayer anchor={EMPTY_STREAK} theme={theme} />
          <div className="relative m-auto w-full max-w-float py-8">
            {/* The streak shows around the block, never at full strength behind its text (decision 21). */}
            <div aria-hidden className="octo-streak-scrim" />
            <div className="relative">
              {/* The project's name is already in the sidebar and the header: the title says what to do. */}
              <div className="relative">
                <h1 className="relative text-center text-title text-fg">What should the orchestrator do first?</h1>
                <p className="relative mt-2 text-center text-sm text-fg-2">It plans, delegates to sub-agents and keeps notes.</p>
              </div>
              <div className="relative mt-6">
                <Composer
                  ref={composer}
                  {...composerProps}
                  comments={
                    composerProps.commentCount
                      ? { count: composerProps.commentCount, render: (open, setOpen) => <CommentsControl open={open} onOpenChange={setOpen} /> }
                      : undefined
                  }
                />
              </div>
            </div>
            <div className="relative mt-4">
              <StarterPrompts project={project} onPick={(text) => composer.current?.fill(text)} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="@container/conv relative flex h-full min-h-0 flex-col [--pad:24px] @max-[560px]/conv:[--pad:16px]">
      {isOrchestrator && <ChatHeader requests={requests} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {stuckPrompt && (
          <StickyPrompt
            key={stuckPrompt.id}
            text={requestTitle(promptText(stuckPrompt))}
            author={isOrchestrator ? null : parent ? roleName(parent) : "Parent"}
            onHeight={stuck.setPinnedHeight}
          />
        )}
        {requests.length >= RAIL_MIN_REQUESTS && (
          // The rail sits in the column's left padding, 4px clear of it; hidden when the padding is 16. The
          // layer covers the whole scroll area (it clips like the transcript) but takes no pointer events.
          <div className={cn(EDGES, "pointer-events-none absolute inset-x-0 top-0 z-20 @max-[560px]/conv:hidden")} style={{ height: scrollHeight }}>
            <div className="relative mx-auto max-w-measure">
              <div className="pointer-events-auto absolute top-2 right-full mr-3">
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
          className="scroll-quiet min-h-0 flex-1 overflow-y-auto"
        >
          <div className="px-(--pad)">
            <div data-column className="mx-auto w-full max-w-measure pt-2 pb-8">
              {!isOrchestrator && <AgentHeader agent={agent} now={now} />}
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
        {!scroll.atBottom && (
          // Scrolled up, the view ends 40px higher: the button gets its own room below the transcript
          // (4 + 32 + 4), so it never sits on text, and the last 12px of text fade out above that room.
          // The content does not move (the scroll position is kept); at the bottom the room goes again.
          <div data-jump-room className="relative flex h-10 shrink-0 items-center justify-center">
            <div aria-hidden className="octo-fade scroll-quiet pointer-events-none absolute inset-x-0 -top-3 h-3 overflow-hidden">
              <div className="h-full bg-linear-to-t from-panel to-transparent" />
            </div>
            <button
              type="button"
              onClick={() => scroll.scrollToBottom(true)}
              aria-label="Jump to latest"
              title="Jump to latest"
              className="press octo-fade grid size-8 place-items-center rounded-full border border-line-strong bg-overlay text-fg-2 shadow-pop octo-ring-pop hover:text-fg"
            >
              <Glyph icon={ArrowDown} size={14} />
            </button>
          </div>
        )}
      </div>

      <div className={cn(EDGES, "shrink-0 pb-3")}>
        <div data-column-edge className="mx-auto w-full max-w-measure">
          {isOrchestrator ? (
            <Composer
              ref={composer}
              {...composerProps}
              comments={
                composerProps.commentCount
                  ? { count: composerProps.commentCount, render: (open, setOpen) => <CommentsControl open={open} onOpenChange={setOpen} /> }
                  : undefined
              }
            />
          ) : (
            <ObserverBar />
          )}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {agent.status === "running" ? `${roleName(agent)} is working` : ""}
      </p>
    </div>
  );
}
