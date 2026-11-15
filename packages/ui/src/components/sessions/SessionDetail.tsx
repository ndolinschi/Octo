import type { Agent, Message, ProjectSession } from "@octo/agent-client";
import { MessageSquareShare } from "lucide-react";
import { useState } from "react";
import { formatTokens } from "../../lib/format";
import { EMPTY_FIRST_LINE, EMPTY_SESSION_LINE } from "../../lib/sessions/carry";
import { canDelete, detailLine, earlierSession, hasNoRequests, isDefaultSession, isWorking, parentOf } from "../../lib/sessions/model";
import { roleText } from "../../lib/orchestrator";
import { useModelNames } from "../../state/modelNames";
import { useProject } from "../../state/project";
import { useNav } from "../../state/nav";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { SkeletonText } from "../primitives/Skeleton";
import { Prose } from "../shared/Prose";
import { BoundaryMarker, QuietLine, type TranscriptSlot } from "./parts";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { SessionComposer } from "./SessionComposer";
import { SessionHeader } from "./SessionHeader";
import { useCompact } from "./useCompact";
import { useSessionActions } from "./useSessionActions";
import { useSessionConversation } from "./useSessionConversation";

/** The reading width of a detail pane, as Memory's. */
const DETAIL_MAX = "w-full max-w-3xl";

/**
 * One session: its header with actions, for an agent its task, who started it and its usage, then the conversation in the
 * project chat's own transcript (`renderTranscript`), and at the bottom what can be done next: a composer for an agent
 * session that can take a message, "Resume" / "Open conversation" for a main one.
 */
export function SessionDetail(props: {
  session: ProjectSession;
  list: readonly ProjectSession[];
  now: number;
  renderTranscript: TranscriptSlot;
  onSelect?: ((id: string) => void) | undefined;
  /** A delegation row in the transcript asks for that agent's session. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onOpenInTab?: ((id: string) => void) | undefined;
  /** The session was deleted: the owner leaves it. */
  onGone(): void;
}) {
  const s = props.session;
  const actions = useSessionActions();
  const { name } = useModelNames();
  const { projectId, project, state } = useProject();
  const ws = useOptionalWorkspace();
  const nav = useNav();
  const conversation = useSessionConversation(s);
  const { ref, compact } = useCompact();
  const earlier = s.kind === "main" ? earlierSession(props.list, s, conversation.status === "ok" ? conversation.boundary : undefined) : null;
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const parent = parentOf(props.list, s);
  const agent: Agent | undefined = s.kind === "agent" && s.agent_id ? state.agents[s.agent_id] : undefined;
  const orchestratorName = project?.name ?? "Octo";

  const openRequest = () => {
    if (!s.turn_id) return;
    // The request is in the conversation of the session that started the agent (decision 96: that session's tab).
    if (parent && ws) ws.showSession(parent.id);
    else ws?.focusChat();
    nav.requestTurn({ projectId, messageId: s.turn_id });
  };
  return (
    <div ref={ref} className={DETAIL_MAX}>
      <SessionHeader
        session={s}
        line={detailLine(s, props.now, name)}
        renaming={renaming}
        busy={actions.busy}
        onStartRename={() => setRenaming(true)}
        onCancelRename={() => setRenaming(false)}
        onRename={(title) => {
          setRenaming(false);
          void actions.rename(s.id, title);
        }}
        onMakeDefault={() => void actions.makeDefault(s.id)}
        onOpen={s.kind === "main" && ws ? () => ws.showSession(s.id) : undefined}
        onArchive={(next) => void actions.archive(s.id, next)}
        canDelete={canDelete(props.list, s)}
        onDelete={() => {
          actions.clear();
          setConfirm(true);
        }}
        onStop={() => void actions.stop(s.id)}
        onOpenInTab={props.onOpenInTab ? () => props.onOpenInTab?.(s.id) : undefined}
      />
      {s.kind === "agent" && (
        <AgentFacts
          session={s}
          agent={agent}
          fallbackTask={firstUserText(conversation.status === "ok" ? conversation.messages : [])}
          startedBy={parent ? (isDefaultSession(parent) ? orchestratorName : parent.title) : orchestratorName}
          canOpenRequest={parent !== undefined && Boolean(s.turn_id)}
          onOpenRequest={openRequest}
          onOpenParent={parent && props.onSelect ? () => props.onSelect?.(parent.id) : undefined}
        />
      )}
      {s.kind === "main" && s.summary && (
        <div className="px-2 pb-2 text-fg-2">
          <Prose size="compact" text={s.summary} />
        </div>
      )}
      {actions.error && !confirm && s.kind === "main" && (
        <div className="px-2 pb-2">
          <Notice tone="error">{actions.error}</Notice>
        </div>
      )}
      <div className="px-2">
        {earlier && conversation.status === "ok" && (
          <BoundaryMarker
            earlier={earlier.title}
            onOpenEarlier={earlier.id !== null && props.onSelect ? () => props.onSelect?.(earlier.id ?? "") : undefined}
          />
        )}
        {conversation.status === "loading" && <SkeletonText lines={5} className="pt-2" />}
        {conversation.status === "error" && <Notice tone="error">{`Could not read this session. ${conversation.message}`}</Notice>}
        {conversation.status === "ok" &&
          (conversation.messages.length === 0 ? (
            <QuietLine>
              {isWorking(s)
                ? "Nothing yet. The first words appear here as they are written."
                : hasNoRequests(s)
                  ? earlier
                    ? EMPTY_SESSION_LINE
                    : EMPTY_FIRST_LINE
                  : "This session has no messages."}
            </QuietLine>
          ) : (
            props.renderTranscript({
              agent: conversation.agent,
              messages: conversation.messages,
              speaker: s.kind === "main" ? orchestratorName : roleText(conversation.agent.role),
              promptAuthor: s.kind === "main" ? "You" : orchestratorName,
              hideFirstPrompt: s.kind === "agent",
              density: compact ? "compact" : undefined,
              onOpenSession: props.onOpenAgent,
            })
          ))}
      </div>
      <footer className="sticky -bottom-6 mt-4 -mb-6 bg-panel px-2 pt-2 pb-10">
        {s.kind === "agent" ? (
          <SessionComposer key={`${s.id}:${s.can_message}`} session={s} actions={actions} />
        ) : (
          <MainFooter
            session={s}
            busy={actions.busy}
            onMakeDefault={() => void actions.makeDefault(s.id)}
            onOpenConversation={() => (ws ? ws.showSession(s.id) : undefined)}
          />
        )}
      </footer>
      {confirm && <DeleteSessionDialog session={s} actions={actions} onClose={() => setConfirm(false)} onDeleted={props.onGone} />}
    </div>
  );
}

/** Decision 96: every main session is open; "Open" shows its conversation (where it continues), "Make default" moves where unaddressed messages go. */
function MainFooter(props: { session: ProjectSession; busy: string | null; onMakeDefault(): void; onOpenConversation(): void }) {
  const isDefault = isDefaultSession(props.session);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <QuietLine>
        {isDefault
          ? "The project's default session: messages sent to the project go here."
          : props.session.archived
            ? "Archived. Open it to continue; a message brings it back."
            : "Open it to continue this session."}
      </QuietLine>
      {!isDefault && (
        <Button variant="quiet" size="sm" className="ml-auto shrink-0" loading={props.busy === "resume"} onClick={props.onMakeDefault}>
          Make default
        </Button>
      )}
      <Button variant="primary" size="sm" icon={MessageSquareShare} className={isDefault ? "ml-auto shrink-0" : "shrink-0"} onClick={props.onOpenConversation}>
        Open
      </Button>
    </div>
  );
}

function firstUserText(messages: readonly Message[]): string {
  const m = messages.find((x) => x.role === "user");
  return m
    ? m.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join(" ")
        .trim()
    : "";
}

/** Task, who started it (with "Open request" into the conversation), model and usage of an agent session. */
function AgentFacts(props: {
  session: ProjectSession;
  agent: Agent | undefined;
  fallbackTask: string;
  startedBy: string;
  canOpenRequest: boolean;
  onOpenRequest(): void;
  onOpenParent: (() => void) | undefined;
}) {
  const task = props.agent?.task.trim() || props.fallbackTask;
  const used = props.agent ? props.agent.input_tokens + props.agent.output_tokens : 0;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-2 pb-3">
      {task !== "" && <p className="border-l-2 border-line-strong pl-3 text-sm break-words whitespace-pre-wrap text-fg-2">{task}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-3">
        <span className="min-w-0 truncate">
          Started by {props.startedBy}
          {used > 0 ? ` · ${formatTokens(used)} tokens` : ""}
        </span>
        {props.canOpenRequest ? (
          <Button variant="quiet" size="xs" icon={MessageSquareShare} onClick={props.onOpenRequest}>
            Open request
          </Button>
        ) : (
          props.onOpenParent && (
            <Button variant="quiet" size="xs" onClick={props.onOpenParent}>
              Open its session
            </Button>
          )
        )}
      </div>
    </div>
  );
}
