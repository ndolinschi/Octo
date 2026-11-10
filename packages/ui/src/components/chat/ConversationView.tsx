import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { promptText } from "../../lib/transcript";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { AgentHeader, roleName } from "./AgentHeader";
import { Composer, type ComposerHandle } from "./Composer";
import { ObserverBar } from "./ObserverBar";
import { StarterPrompts } from "./StarterPrompts";
import { StickyPrompt } from "./StickyPrompt";
import { Transcript } from "./Transcript";
import { useStuckTurn, useTurnRequests, useViewTurn } from "./turnTracking";

export function ConversationView({ agentId }: { agentId: string }) {
  const { health } = useApp();
  const { project, state, running, ensureMessages, send, cancel, projectId, live } = useProject();
  const agent = state.agents[agentId];
  const messages = state.messages[agentId];
  const streaming = state.streaming[agentId];
  const composer = useRef<ComposerHandle>(null);
  const isOrchestrator = agent?.parent_id === null;
  const anyRunning = state.agentOrder.some((id) => state.agents[id]?.status === "running");
  const now = useNow(anyRunning);
  const scroll = useStickToBottom<HTMLDivElement>(
    [messages, streaming, agent?.status, agentId],
    isOrchestrator || agent?.status === "running",
  );

  const stuck = useStuckTurn(scroll.ref);
  const promptCount = useMemo(() => messages?.filter((m) => m.role === "user").length ?? 0, [messages]);
  useViewTurn(scroll.ref, projectId, isOrchestrator, promptCount);
  useTurnRequests({ root: scroll.ref, projectId, enabled: isOrchestrator, loaded: messages !== undefined, release: scroll.release });
  const { onScroll: measureStuck } = stuck;
  useEffect(measureStuck, [messages, streaming, measureStuck]);

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

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
  const scroller = scroll.ref.current;
  const gutter = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
  const offlineReason =
    health === "offline" ? "Bridge offline. Start harness serve to continue." : live === "reconnecting" ? "Reconnecting to the bridge…" : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {stuckPrompt && (
        <StickyPrompt
          key={stuckPrompt.id}
          text={promptText(stuckPrompt)}
          author={isOrchestrator ? null : parent ? roleName(parent) : "Parent"}
          gutter={gutter}
        />
      )}
      <div
        ref={scroll.ref}
        onScroll={() => {
          scroll.onScroll();
          stuck.onScroll();
        }}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-measure px-6 pt-3 pb-8 max-[1000px]:px-4">
          {!isOrchestrator && <AgentHeader agent={agent} now={now} />}
          {showStarters ? (
            <StarterPrompts project={project} onPick={(text) => composer.current?.fill(text)} />
          ) : (
            <Transcript
              agent={agent}
              messages={messages ?? []}
              now={now}
              speaker={roleName(agent)}
              promptAuthor={isOrchestrator ? "You" : parent ? roleName(parent) : "Parent"}
              hideFirstPrompt={!isOrchestrator}
            />
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-6 max-[1000px]:px-4">
        {!scroll.atBottom && (
          <button
            type="button"
            onClick={() => scroll.scrollToBottom(true)}
            aria-label="Jump to latest"
            title="Jump to latest"
            className="absolute right-4 -top-10 grid size-7 place-items-center rounded-full border border-line-strong bg-raised text-fg-2 transition-[color,background-color] duration-100 hover:text-fg"
          >
            <ArrowDown size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
          </button>
        )}
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
          />
        ) : (
          <ObserverBar />
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {agent.status === "running" ? `${roleName(agent)} is working` : ""}
      </p>
    </div>
  );
}
