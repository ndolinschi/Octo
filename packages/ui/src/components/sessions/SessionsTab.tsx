import type { ProjectSession } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { FILTERS, filterCounts, parentOf, toggleOpen, visibleNodes, type SessionFilter } from "../../lib/sessions/model";
import { useApp } from "../../state/app";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useProject } from "../../state/project";
import { onSessionRequest, peekQueuedSession, takeQueuedSession } from "../../state/workspace/sessionsStart";
import { Button } from "../primitives/Button";
import { FilterTabs, type Filter } from "../primitives/FilterTabs";
import { ListDetail } from "../primitives/ListDetail";
import { Notice } from "../primitives/Notice";
import { Panel, PanelEmpty, PanelFilters } from "../primitives/Panel";
import type { TranscriptSlot } from "./parts";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { NewSessionButton } from "./NewSessionButton";
import { SessionDetail } from "./SessionDetail";
import { SessionRows } from "./SessionRows";
import { useSessionActions } from "./useSessionActions";

/**
 * The Sessions tab (project sessions, decision 5; Memory's sibling): main sessions newest first, each opening to the agent
 * sessions it started, filters All · Working · Mine · Agents · Archived, "New session" first in the list header, and the
 * chosen session's conversation beside the list (one column when narrow). `renderTranscript` is the project chat's
 * transcript, handed in by the dock.
 */
export function SessionsTab(props: { renderTranscript: TranscriptSlot; onOpenInTab?: ((id: string) => void) | undefined }) {
  const { bridge } = useApp();
  const { state, projectId } = useProject();
  const list = state.sessions.list;
  const actions = useSessionActions();
  const ws = useOptionalWorkspace();
  const now = useNow(false, CLOCK_MINUTE_MS);
  const [asked] = useState(() => peekQueuedSession(projectId));
  // The request is now this tab's: clear it (also what a tab that mounts again must not see).
  useEffect(() => {
    takeQueuedSession(projectId);
  }, [projectId]);
  const startAt = asked?.sessionId ? list.find((s) => s.id === asked.sessionId) : undefined;
  const [selected, setSelected] = useState<string | null>(asked?.sessionId || null);
  const [filter, setFilter] = useState<SessionFilter>(asked?.filter ?? (startAt?.archived ? "archived" : "all"));
  // "Agents of <session>": the agent chips and delegation rows ask for the agent sessions of one main session.
  const [agentsOf, setAgentsOf] = useState<string | null>(asked?.filter === "agents" ? (asked.agentsOf ?? null) : null);
  const [deleting, setDeleting] = useState<ProjectSession | null>(null);
  const [open, setOpen] = useState<string | null>(startAt?.kind === "agent" ? (startAt.parent_session_id ?? null) : (startAt?.id ?? null));
  // A request made while the tab is already mounted: select that session (an agent's main session opens with it).
  useEffect(
    () =>
      onSessionRequest(() => {
        const req = takeQueuedSession(projectId);
        if (req === null) return;
        const s = req.sessionId ? list.find((x) => x.id === req.sessionId) : undefined;
        setSelected(req.sessionId || null);
        setOpen(s?.kind === "agent" ? (s.parent_session_id ?? null) : (s?.id ?? null));
        setFilter(req.filter ?? (s?.archived ? "archived" : "all"));
        setAgentsOf(req.filter === "agents" ? (req.agentsOf ?? null) : null);
      }),
    [projectId, list],
  );

  const nodes = useMemo(() => visibleNodes(list, filter, filter === "agents" ? agentsOf : null), [list, filter, agentsOf]);
  const counts = useMemo(() => filterCounts(list), [list]);
  const picked = selected !== null ? (list.find((s) => s.id === selected) ?? null) : null;

  if (!bridge.listSessions) {
    return <PanelEmpty title="This version of Octo's local service has no sessions">Update it to see the project's sessions here.</PanelEmpty>;
  }
  // Counts only where they answer a question (what works now, what is archived): five counts do not fit the list column.
  const options: Filter<SessionFilter>[] = FILTERS.map((f) => ({
    id: f.id,
    label: f.label,
    title: f.title,
    ...((f.id === "working" || f.id === "archived") && counts[f.id] > 0 ? { count: counts[f.id] } : {}),
  }));
  return (
    <div data-sessions className="h-full min-h-0">
      <Panel
        name="sessions"
        title="Sessions"
        notice={actions.error ? <Notice tone="error">{actions.error}</Notice> : undefined}
        actions={
          <NewSessionButton
            loading={actions.busy === "create"}
            onCreate={() =>
              void actions.create().then((created) => {
                // Decision 96: "New session" makes and opens a session; the default stays where it is.
                if (created) ws?.showSession(created.id);
                if (!created) return;
                setSelected(created.id);
                setFilter("all");
                setOpen(created.id);
              })
            }
          />
        }
      >
        {list.length === 0 ? (
          <PanelEmpty title="No sessions yet">What you ask in the conversation starts the first session. New session starts another.</PanelEmpty>
        ) : (
          <ListDetail
            label="Sessions"
            listLabel="Sessions"
            listSemantics="own"
            placeholder="Choose a session to read its conversation."
            selected={picked?.id ?? null}
            onSelect={(id) => setSelected(id)}
            listHeader={
              <div className="shrink-0">
                <PanelFilters>
                  <FilterTabs<SessionFilter>
                    bare
                    label="Filter sessions"
                    options={options}
                    value={filter}
                    onChange={(next) => {
                      setFilter(next);
                      setAgentsOf(null);
                    }}
                  />
                </PanelFilters>
                {filter === "agents" && agentsOf !== null && (
                  <div className="flex h-row items-center gap-2 px-4 text-xs text-fg-3">
                    <span className="min-w-0 truncate">Agents of {list.find((s) => s.id === agentsOf)?.title ?? "this session"}</span>
                    <Button variant="link" size="xs" className="shrink-0" onClick={() => setAgentsOf(null)}>
                      All agents
                    </Button>
                  </div>
                )}
              </div>
            }
            list={(select) =>
              nodes.length === 0 ? (
                <PanelEmpty>{emptyText(filter)}</PanelEmpty>
              ) : (
                <SessionRows
                  nodes={nodes}
                  selected={picked?.id ?? null}
                  open={open}
                  openAll={filter === "working"}
                  now={now}
                  onToggle={(s) => setOpen((cur) => toggleOpen(cur, s.id))}
                  menu={{
                    list,
                    onResume: (s) => (ws ? ws.showSession(s.id) : undefined),
                    onMakeDefault: (s) => void actions.makeDefault(s.id),
                    onArchive: (s, archived) => void actions.archive(s.id, archived),
                    onDelete: (s) => {
                      actions.clear();
                      setDeleting(s);
                    },
                  }}
                  onChoose={(s) => {
                    select(s.id);
                    setSelected(s.id);
                    if (s.kind === "agent") setOpen(parentOf(list, s)?.id ?? null);
                    else if (s.children > 0) setOpen((cur) => toggleOpen(cur, s.id));
                  }}
                />
              )
            }
            detail={
              picked ? (
                <SessionDetail
                  key={picked.id}
                  session={picked}
                  list={list}
                  now={now}
                  renderTranscript={props.renderTranscript}
                  onSelect={(id) => {
                    setSelected(id);
                    setOpen(id);
                  }}
                  onOpenAgent={(agentId) => {
                    const agent = list.find((x) => x.agent_id === agentId);
                    if (!agent) return;
                    setSelected(agent.id);
                    setOpen(agent.parent_session_id ?? null);
                  }}
                  onOpenInTab={props.onOpenInTab}
                  onGone={() => setSelected(null)}
                />
              ) : null
            }
          />
        )}
      </Panel>
      {deleting && (
        <DeleteSessionDialog
          session={deleting}
          actions={actions}
          onClose={() => setDeleting(null)}
          onDeleted={() => setSelected((cur) => (cur === deleting.id ? null : cur))}
        />
      )}
    </div>
  );
}

function emptyText(filter: SessionFilter): string {
  switch (filter) {
    case "working":
      return "Nothing is working right now.";
    case "agents":
      return "The orchestrator has not started any agent sessions.";
    case "archived":
      return "No archived sessions. Archive one from its menu to keep the list short.";
    default:
      return "No sessions here.";
  }
}
