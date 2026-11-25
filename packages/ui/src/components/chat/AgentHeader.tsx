import { ancestorsOf, descendantCount, type Agent } from "@octo/agent-client";
import { Button } from "../primitives/Button";
import { roleName } from "../../lib/orchestrator";
import { ChevronRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { Suspense, useId, useState } from "react";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import { agentDuration } from "../../lib/duration";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Markdown } from "../shared/Markdown";
import { statusLabel, tierLabel } from "../primitives/statusMore";
import { contextText } from "../../lib/contextText";
import { CHAT } from "../../state/workspace/layout";
import { retryText } from "./DelegationGroup";
import { prefillComposer } from "./composerDraft";
import { ActivityRow } from "./ActivityRow";
import { useRunHead } from "./useRunCard";
import { RUN_CARD_FRAME, runCardBody } from "./runCardPart";

void runCardBody.fetch().catch(() => undefined);
const RunCardBody = runCardBody.Component;

export function Breadcrumb({ agent }: { agent: Agent }) {
  const { projectId, state } = useProject();
  const ws = useOptionalWorkspace();
  const chain = ancestorsOf(state, agent.id);
  const sep = (
    <span aria-hidden className="text-fg-3">
      /
    </span>
  );
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-fg-3">
        {/* B42: the project is the tab's own context; the root of the chain is the project's conversation. */}
        {chain.map((a, i) => (
          <li key={a.id} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && sep}
            <a
              href={hrefFor(projectId, a.parent_id === null ? null : a.id)}
              onClick={(e) => {
                if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                if (a.parent_id === null) ws.focusChat();
                else ws.openAgent(a.id, { otherSide: e.altKey });
              }}
              className="inline-block h-6 max-w-[200px] truncate rounded-sm py-0.5 leading-5 hover:text-fg"
            >
              {a.parent_id === null ? "Conversation" : roleName(a)}
            </a>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-1.5">
          {chain.length > 0 && sep}
          <span aria-current="page" className="truncate text-fg-2">
            {roleName(agent)}
          </span>
        </li>
      </ol>
    </nav>
  );
}

export function AgentHeader({ agent, now: nowProp }: { agent: Agent; now?: number }) {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const [briefOpen, setBriefOpen] = useState(false);
  const briefId = useId();
  const liveNow = useNow(nowProp === undefined && agent.status === "running");
  const now = nowProp ?? liveNow;
  const duration = agentDuration(agent, now);
  const nested = descendantCount(state, agent.id);
  const head = useRunHead(agent, { name: roleName(agent) });
  // Decision 101: the header's state, model, route and time are the run card (the same one the delegation row opens into),
  // without its steps: the transcript below is the steps. The card's meta adds what only this header said.
  const extra = [
    agent.tier ? tierLabel(agent.tier) : "",
    nested > 0 ? `${nested} nested` : "",
    // Reported by an ACP agent (`usage_update`); absent otherwise — never a guessed window.
    contextText(agent.context_used, agent.context_size) ?? "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="mb-5">
      <Breadcrumb agent={agent} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h1 className="shrink-0 text-heading text-fg">{roleName(agent)}</h1>
        {agent.title && <p className="min-w-0 flex-1 truncate text-base text-fg-2">{agent.title}</p>}
      </div>
      <div data-run-card={head.state} role="region" aria-label={`${roleName(agent)}: run`} className={cn("@container/run mt-2", RUN_CARD_FRAME)}>
        <ActivityRow
          state={head.state}
          data="run-head"
          verb={<span className="text-fg">{head.title}</span>}
          duration={duration}
          tip={agent.status === "failed" && agent.error ? `${head.title}\n\n${agent.error}` : `${statusLabel(agent.status)}: ${head.title}`}
        />
        <Suspense fallback={null}>
          <RunCardBody agentId={agent.id} title={head.title} variant="header" extra={extra || undefined} />
        </Suspense>
      </div>
      {agent.status === "failed" && (
        <p role="note" className="mt-1.5 text-sm text-fg-2">
          {ws ? (
            <Button
              variant="link"
              onClick={() => {
                prefillComposer(ws.memory, CHAT, retryText(roleName(agent), agent.task || agent.title));
                ws.focusChat();
              }}
            >
              Retry
            </Button>
          ) : null}
          {ws ? <span className="text-fg-3"> puts its task back in the box; nothing is sent yet.</span> : "Ask in the session to retry it."}
        </p>
      )}
      {agent.task && (
        <div className="mt-2">
          <Button variant="quiet" size="xs" aria-expanded={briefOpen} aria-controls={briefId} onClick={() => setBriefOpen((o) => !o)} className="-ml-1.5">
            Task brief
            <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-base", briefOpen && "rotate-90")} />
          </Button>
          {briefOpen && (
            <div id={briefId} className="mt-1 border-l border-line-strong pl-3">
              <Markdown text={agent.task} className="octo-prose octo-prose-sm" />
            </div>
          )}
        </div>
      )}
    </header>
  );
}
