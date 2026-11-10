import { ArrowDown, ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNow, useStickToBottom } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { AgentHeader, roleName } from "./AgentHeader";
import { Composer, type ComposerHandle } from "./Composer";
import { ObserverBar } from "./ObserverBar";
import { StarterPrompts } from "./StarterPrompts";
import { Transcript } from "./Transcript";

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

  useEffect(() => {
    ensureMessages(agentId);
  }, [agentId, ensureMessages]);

  if (!project) return null;
  if (!agent) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <p className="text-sm text-fg-2">This agent isn't part of {project.name}.</p>
          <a href={hrefFor(projectId)} className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent">
            <ArrowLeft size={14} aria-hidden /> Back to orchestrator
          </a>
        </div>
      </div>
    );
  }

  const parent = agent.parent_id ? state.agents[agent.parent_id] : undefined;
  const loadedEmpty = messages !== undefined && messages.length === 0;
  const showStarters = isOrchestrator && loadedEmpty && !running;
  const offlineReason =
    health === "offline" ? "Bridge offline — start harness serve to continue" : live === "reconnecting" ? "Reconnecting to the bridge…" : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-measure px-6 pt-8 pb-10 max-[1000px]:px-5">
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

      {!scroll.atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[132px] flex justify-center">
          <button
            type="button"
            onClick={() => scroll.scrollToBottom(true)}
            className="animate-fade-in pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-overlay px-3 text-xs text-fg-2 shadow-pop hover:text-fg"
          >
            <ArrowDown size={13} aria-hidden />
            Jump to latest
          </button>
        </div>
      )}

      <div className="relative shrink-0 px-6 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-b before:from-transparent before:to-bg max-[1000px]:px-5">
        {isOrchestrator ? (
          <Composer
            ref={composer}
            running={running}
            disabledReason={offlineReason}
            folders={project.folders}
            model={project.models.orchestrator}
            onSend={send}
            onCancel={cancel}
          />
        ) : (
          <ObserverBar role={agent.role} />
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {agent.status === "running" ? `${roleName(agent)} is working` : ""}
      </p>
    </div>
  );
}
