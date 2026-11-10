import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { promptText } from "../../lib/transcript";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { CHAT } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { AgentHeader, roleName } from "./AgentHeader";
import { Composer, type ComposerHandle } from "./Composer";
import { ObserverBar } from "./ObserverBar";
import { StarterPrompts } from "./StarterPrompts";
import { StickyPrompt } from "./StickyPrompt";
import { Transcript } from "./Transcript";
import { useStuckTurn, useTurnRequests, useViewTurn } from "./turnTracking";

type ScrollMemory = { top: number; atBottom: boolean };

/**
 * A conversation (the orchestrator's Chat tab or a sub-agent's Agent tab). The transcript column,
 * the pinned prompt and the composer / read-only bar share both edges exactly: the scroll area
 * reserves its scrollbar gutter on both sides (`scroll-quiet`) and the rows outside it add the same
 * gutter (`--sg`) to the same padding (`--pad`).
 */
export function ConversationView({ agentId, tab = CHAT }: { agentId: string; tab?: string }) {
  const { health } = useApp();
  const ws = useOptionalWorkspace();
  const { project, state, running, ensureMessages, send, cancel, projectId, live } = useProject();
  const agent = state.agents[agentId];
  const messages = state.messages[agentId];
  const streaming = state.streaming[agentId];
  const composer = useRef<ComposerHandle>(null);
  const isOrchestrator = agent?.parent_id === null;
  const anyRunning = state.agentOrder.some((id) => state.agents[id]?.status === "running");
  const now = useNow(anyRunning);
  const memory = ws?.memory;
  const saved = memory?.get(`${tab}:scroll`) as ScrollMemory | undefined;
  const scroll = useStickToBottom<HTMLDivElement>(
    [messages, streaming, agent?.status, agentId],
    saved ? saved.atBottom : isOrchestrator || agent?.status === "running",
  );
  const [gutter, setGutter] = useState(0);

  const stuck = useStuckTurn(scroll.ref);
  const promptCount = useMemo(() => messages?.filter((m) => m.role === "user").length ?? 0, [messages]);
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

  // Half of the reserved scrollbar space: the same inset for the rows outside the scroll area.
  useLayoutEffect(() => {
    const el = scroll.ref.current;
    if (!el) return;
    const measure = () => setGutter(Math.max(0, (el.offsetWidth - el.clientWidth) / 2));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroll.ref, agent]);

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
      if (el && memory) memory.set(`${tab}:scroll`, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 80 });
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
  const offlineReason =
    health === "offline" ? "Bridge offline. Start harness serve to continue." : live === "reconnecting" ? "Reconnecting to the bridge…" : null;
  const draftKey = `${tab}:draft`;

  return (
    <div
      className="@container/conv relative flex h-full min-h-0 flex-col [--pad:24px] @max-[560px]/conv:[--pad:16px]"
      style={{ "--sg": `${gutter}px` } as CSSProperties}
    >
      {stuckPrompt && (
        <StickyPrompt key={stuckPrompt.id} text={promptText(stuckPrompt)} author={isOrchestrator ? null : parent ? roleName(parent) : "Parent"} />
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
          <div data-column className="mx-auto w-full max-w-measure pt-3 pb-8">
            {!isOrchestrator && <AgentHeader agent={agent} now={now} />}
            {showStarters ? (
              <StarterPrompts project={project} onPick={(text) => composer.current?.fill(text)} />
            ) : (
              <Transcript
                agent={agent}
                messages={messages ?? []}
                now={now}
                watched={watched}
                speaker={roleName(agent)}
                promptAuthor={isOrchestrator ? "You" : parent ? roleName(parent) : "Parent"}
                hideFirstPrompt={!isOrchestrator}
              />
            )}
          </div>
        </div>
      </div>

      <div className="relative shrink-0 px-[calc(var(--pad)+var(--sg))]">
        {!scroll.atBottom && (
          <button
            type="button"
            onClick={() => scroll.scrollToBottom(true)}
            aria-label="Jump to latest"
            title="Jump to latest"
            className="press absolute -top-11 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-raised text-fg-2 shadow-pop hover:text-fg"
          >
            <ArrowDown size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
          </button>
        )}
        <div data-column className="mx-auto w-full max-w-measure pb-3">
          {isOrchestrator ? (
            <Composer
              ref={composer}
              running={running}
              disabledReason={offlineReason}
              followUp={(messages?.length ?? 0) > 0}
              folders={project.folders}
              model={project.models.orchestrator}
              onSend={send}
              onCancel={cancel}
              draft={memory ? { initial: (memory.get(draftKey) as string | undefined) ?? "", save: (text) => memory.set(draftKey, text) } : undefined}
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
