import type { ContextReceipt } from "@octo/agent-client";
import { useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { cn } from "../../lib/cn";
import { requestTitle } from "../../lib/comments";
import { formatRelative, formatTokens } from "../../lib/format";
import { blockColor, idKind, receiptView, type BarSegment } from "../../lib/memory/receipt";
import { splitFactId, type HitTarget } from "../../lib/memory/search";
import { formatDay } from "../../lib/memory/tasks";
import { promptText } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { Block, DetailTitle, Empty, ErrorState, ListDetail, ListRow, Loading, RowList } from "./parts";
import { useReceipt } from "./useMemory";

type Turn = { id: number; text: string; at: string };

/**
 * Context: for one request, what the orchestrator had in front of it (the receipt of its first model call). The bar
 * shows each block's share of the tokens sent; each block lists its cap and the ids it carried.
 */
export function ContextTab(props: {
  projectId: string;
  selected: number | null;
  onSelect(id: number | null): void;
  onOpen(target: NonNullable<HitTarget>): void;
  canOpenMessage: boolean;
}) {
  const { state, project } = useProject();
  const messages = project ? state.messages[project.orchestrator_agent_id] : undefined;
  const turns = useMemo<Turn[]>(
    () =>
      (messages ?? [])
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: requestTitle(promptText(m)).trim(), at: m.created_at }))
        .filter((t) => t.text !== "")
        .reverse(),
    [messages],
  );
  const now = useNow(false, CLOCK_MINUTE_MS);
  const current =
    turns.find((t) => t.id === props.selected) ?? (props.selected !== null ? { id: props.selected, text: `Request ${props.selected}`, at: "" } : null);
  if (!messages) return <Loading />;
  if (turns.length === 0)
    return <Empty title="No requests yet">Send the orchestrator a request; the receipt of what it had in front of it appears here.</Empty>;
  return (
    <ListDetail
      label="Context"
      listLabel="Requests"
      placeholder="Choose a request to see what the orchestrator had in front of it."
      onBack={() => props.onSelect(null)}
      listHeader={<p className="flex h-row shrink-0 items-center px-4 text-xs text-fg-3">Newest first</p>}
      list={
        <RowList label="Requests">
          {turns.map((t) => (
            <ListRow
              key={t.id}
              selected={t.id === props.selected}
              onClick={() => props.onSelect(t.id)}
              label={t.text}
              title={t.text}
              trailing={formatRelative(t.at, now)}
            />
          ))}
        </RowList>
      }
      detail={
        current ? (
          <Receipt key={current.id} projectId={props.projectId} turn={current} onOpen={props.onOpen} canOpenMessage={props.canOpenMessage} now={now} />
        ) : null
      }
    />
  );
}

function Receipt(props: { projectId: string; turn: Turn; now: number; canOpenMessage: boolean; onOpen(target: NonNullable<HitTarget>): void }) {
  const load = useReceipt(props.projectId, props.turn.id);
  const { turn } = props;
  return (
    <article aria-label="Context receipt">
      <DetailTitle title={turn.text}>
        {turn.at && <span>Sent {formatDay(turn.at, props.now)}</span>}
        <span className="font-mono">Turn {turn.id}</span>
      </DetailTitle>
      {load.status === "loading" && <Loading rows={5} />}
      {load.status === "error" && <ErrorState message={load.message} />}
      {load.status === "none" && (
        <Empty title="No receipt for this request">It ran before the harness kept receipts, or the turn has not reached its first model call.</Empty>
      )}
      {load.status === "ok" && <ReceiptBody receipt={load.value} {...props} />}
    </article>
  );
}

function ReceiptBody(props: { receipt: ContextReceipt; canOpenMessage: boolean; onOpen(target: NonNullable<HitTarget>): void }) {
  const v = useMemo(() => receiptView(props.receipt), [props.receipt]);
  const summary = `${v.totalText}. ${v.segments.map((s) => `${s.label} ${formatTokens(s.tokens)}`).join(", ")}`;
  return (
    <>
      <Block title={v.modeText}>
        <div role="img" aria-label={summary} className="flex h-3 w-full gap-px overflow-hidden rounded-xs bg-hover">
          {v.segments
            .filter((s) => s.tokens > 0)
            .map((s) => (
              <span
                key={s.name}
                className="h-full min-w-0.5 shrink-0"
                style={{ width: `${(s.share * 100).toFixed(2)}%`, background: blockColor(s.name) }}
                title={`${s.label}: ${formatTokens(s.tokens)}`}
              />
            ))}
        </div>
        <p className="text-sm text-fg">{v.totalText}</p>
        {v.clearedText && <p className="text-xs text-fg-3">{v.clearedText}</p>}
      </Block>
      <ul className="flex flex-col gap-3 pt-4">
        {v.segments.map((s) => (
          <BlockRow key={s.name} segment={s} onOpen={props.onOpen} canOpenMessage={props.canOpenMessage} />
        ))}
      </ul>
    </>
  );
}

const IDS_SHOWN = 8;

function BlockRow(props: { segment: BarSegment; canOpenMessage: boolean; onOpen(target: NonNullable<HitTarget>): void }) {
  const s = props.segment;
  const [all, setAll] = useState(false);
  const ids = all ? s.ids : s.ids.slice(0, IDS_SHOWN);
  return (
    <li className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span aria-hidden className="size-2 shrink-0 rounded-2xs" style={{ background: blockColor(s.name) }} />
        <span className="min-w-0 flex-1 truncate text-fg">{s.label}</span>
        <span className="shrink-0 text-fg-2 tabular-nums">{formatTokens(s.tokens)}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-fg-3">
        <span>{(s.share * 100).toFixed(s.share > 0 && s.share < 0.1 ? 1 : 0)}% of the total</span>
        <span>
          {s.count} {s.count === 1 ? "item" : "items"}
        </span>
        {s.cap > 0 ? (
          <span className={cn("flex items-center gap-1.5", s.capped && "text-warn")}>
            <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-hover">
              <span className="block h-full rounded-full bg-fg-3" style={{ width: `${((s.fill ?? 0) * 100).toFixed(1)}%` }} />
            </span>
            <span>
              cap {formatTokens(s.cap)}
              {s.capped ? ", reached" : ""}
            </span>
          </span>
        ) : (
          <span>no cap</span>
        )}
      </div>
      {s.ids.length > 0 && (
        <ul aria-label={`${s.label}: what it carried`} className="flex min-w-0 flex-wrap gap-1 pl-4">
          {ids.map((id) => (
            <li key={id} className="min-w-0">
              <IdChip name={s.name} id={id} onOpen={props.onOpen} canOpenMessage={props.canOpenMessage} />
            </li>
          ))}
          {s.ids.length > IDS_SHOWN && (
            <li>
              <button
                type="button"
                aria-expanded={all}
                onClick={() => setAll(!all)}
                className="h-chip rounded-sm px-2 text-xs text-fg-3 focus-inset hover:bg-hover hover:text-fg"
              >
                {all ? "Show fewer" : `${s.ids.length - IDS_SHOWN} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function IdChip(props: { name: string; id: string; canOpenMessage: boolean; onOpen(target: NonNullable<HitTarget>): void }) {
  const kind = idKind(props.name, props.id);
  const target: HitTarget =
    kind === "file"
      ? { to: "file", path: props.id }
      : kind === "task"
        ? { to: "task", taskId: props.id, factId: null }
        : kind === "fact"
          ? ((r) => (r ? { to: "task", taskId: r.taskId, factId: r.factId } : null))(splitFactId(props.id))
          : kind === "message" && props.canOpenMessage
            ? { to: "message", messageId: Number(props.id) }
            : null;
  const cls = "block h-chip max-w-full truncate rounded-sm bg-hover px-2 font-mono text-xs leading-6";
  return target ? (
    <button type="button" title={props.id} onClick={() => props.onOpen(target)} className={cn(cls, "text-fg-2 focus-inset hover:text-fg")}>
      {props.id}
    </button>
  ) : (
    <span title={props.id} className={cn(cls, "text-fg-3")}>
      {props.id}
    </span>
  );
}
