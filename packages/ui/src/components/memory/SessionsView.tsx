import type { MemorySessionDetail } from "@octo/agent-client";
import { useMemo, useRef, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { useListStops } from "../../lib/listStops";
import { formatDay } from "../../lib/memory/dates";
import { endedNote, exchangeCount, newestFirst, sessionRow, toggleExpanded } from "../../lib/memory/sessions";
import { liveOrchestratorState } from "../../lib/orchestrator";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { requestSession } from "../../state/workspace/sessionsStart";
import { IconMenu } from "../primitives/IconMenu";
import { ListDetail } from "../primitives/ListDetail";
import { ListRow } from "../primitives/ListRow";
import { DetailHeader } from "../primitives/Panel";
import { SkeletonText } from "../primitives/SkeletonText";
import { StateGlyph } from "../primitives/StateGlyph";
import { Prose } from "../shared/Prose";
import { ExchangeRow } from "./ExchangeRow";
import { DETAIL_MAX, MemoryError, PaneEmpty, RowLine } from "./parts";
import { useSession, useSessions } from "./useMemory";

/**
 * Sessions (decision 93 d). The list: a quiet "current" mark, the working glyph on a session in use, "Nov 12 · 5 exchanges".
 * A session opens as a page (one column, one back control) or beside the list (wide); its exchanges are rows that open in place.
 */
export function SessionsView(props: {
  projectId: string;
  selected: string | null;
  /** An exchange to open and scroll to (a search hit). */
  focusExchange: string | null;
  onSelect(id: string | null): void;
  onOpenMessage?: ((turnId: number) => void) | undefined;
}) {
  const sessions = useSessions(props.projectId);
  const { state, running } = useProject();
  // The session entity (project sessions) says which main session is current and whether its turn runs.
  const currentId = state.sessions.currentId;
  const working = useMemo(() => {
    const entity = currentId === null ? undefined : state.sessions.list.find((x) => x.id === currentId);
    if (entity) return entity.state === "working" || entity.state === "waiting";
    return liveOrchestratorState(state, running ? "running" : "idle").kind === "working";
  }, [state, running, currentId]);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const list = useMemo(() => (sessions.load.status === "ok" ? newestFirst(sessions.load.value) : []), [sessions.load]);
  const picked = props.selected !== null && list.some((s) => s.id === props.selected) ? props.selected : null;
  const shownId = picked ?? list[0]?.id ?? null;
  const rows = useRef<HTMLUListElement>(null);
  useListStops(rows);

  if (sessions.load.status === "error") return <MemoryError message={sessions.load.message} onRetry={sessions.reload} />;
  if (sessions.load.status === "ok" && list.length === 0) {
    return <PaneEmpty title="No sessions yet">Each request you make is kept here with its answer, word for word.</PaneEmpty>;
  }
  return (
    <ListDetail
      label="Sessions"
      listLabel="Sessions"
      placeholder="Choose a session to read its requests and answers."
      loading={sessions.load.status === "loading"}
      selected={picked}
      onSelect={(id) => props.onSelect(id)}
      listSemantics="own"
      list={(select) => (
        <ul ref={rows} aria-label="Sessions" className="flex flex-col gap-1.5">
          {list.map((s) => {
            const r = sessionRow(s, now, working, currentId);
            return (
              <li key={s.id}>
                <ListRow
                  size="md"
                  selected={s.id === shownId}
                  // P3: the glyph column of every session list (the Sessions tab's): working, else the quiet idle dot.
                  leading={<StateGlyph state={r.working ? "working" : "idle"} />}
                  title={r.title}
                  description={<RowLine {...(r.current ? { end: "current" } : {})}>{r.description}</RowLine>}
                  tip={r.title}
                  onClick={() => select(s.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
      detail={
        shownId ? (
          <SessionDetail
            // A new search hit in the same session opens its exchange afresh.
            key={`${shownId}:${picked === shownId ? (props.focusExchange ?? "") : ""}`}
            projectId={props.projectId}
            id={shownId}
            tick={sessions.tick}
            onChanged={sessions.reload}
            now={now}
            focusExchange={picked === shownId ? props.focusExchange : null}
            onOpenMessage={props.onOpenMessage}
          />
        ) : null
      }
    />
  );
}

function SessionDetail(props: {
  projectId: string;
  id: string;
  tick: number;
  onChanged(): void;
  now: number;
  focusExchange: string | null;
  onOpenMessage?: ((turnId: number) => void) | undefined;
}) {
  const { bridge } = useApp();
  const ws = useOptionalWorkspace();
  const load = useSession(props.projectId, props.id, props.tick);
  const [open, setOpen] = useState<string | null>(props.focusExchange);
  // The list mounts after the load; `useRowKeys` rebinds when its container appears.
  const exchangeRows = useRef<HTMLUListElement>(null);
  // Item 9 (polish pass F3): one Tab stop; a request's "⋯" is the pointer's way, Shift+F10 the keyboard's.
  useListStops(exchangeRows);
  if (load.status === "loading") return <SkeletonText lines={5} className="px-2 pt-4" />;
  if (load.status === "error") return <MemoryError message={load.message} />;
  const { session, exchanges }: MemorySessionDetail = load.value;
  const forget = bridge.forgetExchange;
  const note = endedNote(session);
  return (
    <div className={DETAIL_MAX}>
      <DetailHeader
        title={session.title}
        meta={[formatDay(session.started_at, props.now), exchangeCount(session.exchanges), note].filter(Boolean).join(" · ")}
        {...(ws
          ? {
              actions: (
                <IconMenu
                  label="Session actions"
                  items={[
                    {
                      id: "open-sessions",
                      label: "Open in Sessions",
                      run: () => {
                        ws.openTool("sessions");
                        requestSession(props.projectId, session.id);
                      },
                    },
                  ]}
                />
              ),
            }
          : {})}
      />
      {session.summary && (
        <div className="px-2 pt-1 pb-3 text-fg-2">
          <Prose size="compact" text={session.summary} />
        </div>
      )}
      <ul ref={exchangeRows} aria-label="Requests" className="flex flex-col">
        {exchanges.map((e) => (
          <ExchangeRow
            key={e.id}
            projectId={props.projectId}
            exchange={e}
            now={props.now}
            open={open === e.id}
            reveal={e.id === props.focusExchange}
            onToggle={() => setOpen((cur) => toggleExpanded(cur, e.id))}
            onClose={() => setOpen(null)}
            onOpenMessage={props.onOpenMessage}
            onForget={async (id) => {
              if (!forget) throw new Error("This version of Octo's local service can't forget a request.");
              await forget.call(bridge, props.projectId, id);
              props.onChanged();
            }}
          />
        ))}
      </ul>
    </div>
  );
}
