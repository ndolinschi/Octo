import type { MemorySessionDetail } from "@octo/agent-client";
import { useEffect, useMemo, useRef } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import { formatSeparator } from "../../lib/format";
import { endedNote, exchangeCount, newestFirst } from "../../lib/memory/sessions";
import { formatDay } from "../../lib/memory/tasks";
import { useApp } from "../../state/app";
import { ExchangeCard } from "./ExchangeCard";
import { DetailTitle, Empty, ErrorState, ListDetail, Loading, RowList } from "./parts";
import { useSession, useSessions } from "./useMemory";

/**
 * Sessions (orchestrator memory M4): what was asked and what was answered, grouped by conversation. The list is newest
 * first (title, day, exchange count); the detail is the session's request → answer pairs.
 */
export function SessionsTab(props: {
  projectId: string;
  selected: string | null;
  /** An exchange to scroll to and mark (a search hit). */
  focusExchange: string | null;
  onSelect(id: string | null, exchange?: string): void;
  onOpenMessage?: ((turnId: number) => void) | undefined;
}) {
  const sessions = useSessions(props.projectId);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const list = useMemo(() => (sessions.load.status === "ok" ? newestFirst(sessions.load.value) : []), [sessions.load]);
  const picked = props.selected !== null && list.some((s) => s.id === props.selected) ? props.selected : null;

  if (sessions.load.status === "loading") return <Loading rows={7} />;
  if (sessions.load.status === "error") return <ErrorState message={sessions.load.message} onRetry={sessions.reload} />;
  if (list.length === 0) {
    return <Empty title="No sessions yet">Each request you make is kept here with its answer, word for word.</Empty>;
  }
  return (
    <ListDetail
      label="Sessions"
      listLabel="Sessions"
      placeholder="Choose a session to read its requests and answers."
      onBack={() => props.onSelect(null)}
      list={
        <RowList label="Sessions">
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                data-row
                aria-current={s.id === picked ? "true" : undefined}
                title={s.title}
                onClick={() => props.onSelect(s.id)}
                className={cn(
                  "flex min-h-row-nav w-full min-w-0 flex-col justify-center rounded-sm px-2 py-1 text-left text-sm press-row focus-inset",
                  s.id === picked ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                <span className="truncate">{s.title}</span>
                <span className="flex items-center gap-1.5 truncate text-xs text-fg-3">
                  <span>{formatDay(s.started_at, now)}</span>
                  <span aria-hidden>·</span>
                  <span>{exchangeCount(s.exchanges)}</span>
                </span>
              </button>
            </li>
          ))}
        </RowList>
      }
      detail={
        picked ? (
          <SessionDetail
            projectId={props.projectId}
            id={picked}
            tick={sessions.tick}
            onChanged={sessions.reload}
            now={now}
            focusExchange={props.focusExchange}
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
  const load = useSession(props.projectId, props.id, props.tick);
  const box = useRef<HTMLDivElement>(null);
  const loaded = load.status === "ok" ? load.value : null;
  const target = props.focusExchange;
  useEffect(() => {
    if (!loaded || !target) return;
    box.current?.querySelector(`[data-exchange="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "center" });
  }, [loaded, target]);
  if (load.status === "loading") return <Loading rows={5} />;
  if (load.status === "error") return <ErrorState message={load.message} />;
  const { session, exchanges }: MemorySessionDetail = load.value;
  const forget = bridge.forgetExchange;
  const note = endedNote(session);
  return (
    <div ref={box}>
      <DetailTitle title={session.title}>
        <span>
          {formatSeparator(session.started_at, props.now)}
          {session.ended_at !== session.started_at && ` to ${formatSeparator(session.ended_at, props.now)}`}
        </span>
        <span>{exchangeCount(session.exchanges)}</span>
        {note && <span>{note}</span>}
      </DetailTitle>
      <ul aria-label="Exchanges" className="mt-3 flex flex-col">
        {exchanges.map((e) => (
          <ExchangeCard
            key={e.id}
            exchange={e}
            now={props.now}
            highlighted={e.id === target}
            onOpenMessage={props.onOpenMessage}
            onForget={async (id) => {
              if (!forget) throw new Error("This harness cannot forget an exchange.");
              await forget.call(bridge, props.projectId, id);
              props.onChanged();
            }}
          />
        ))}
      </ul>
    </div>
  );
}
