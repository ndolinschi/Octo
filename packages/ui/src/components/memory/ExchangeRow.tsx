import type { MemoryExchange } from "@octo/agent-client";
import { CircleAlert, CircleCheck, CirclePause, Eraser, MessageSquareShare } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { exchangeRow, metaLine, metaParts, needsFullRequest, OUTCOME_LABEL, statusNote, type Outcome } from "../../lib/memory/sessions";
import { useModelNames } from "../../state/modelNames";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { IconMenu } from "../primitives/IconMenu";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { Presence } from "../primitives/Presence";
import { Prose } from "../shared/Prose";
import { ReceiptPopover } from "../shared/ReceiptPopover";
import { ConfirmDialog, Expansion, RowLine, useCollapseOnEscape, useReveal } from "./parts";

const OUTCOME_ICON = { done: CircleCheck, failed: CircleAlert, stopped: CirclePause } as const;

function OutcomeGlyph({ outcome }: { outcome: Outcome }) {
  // Only a failure is coloured (decision 93: nothing coloured except state glyphs).
  return <Glyph icon={OUTCOME_ICON[outcome]} size={14} className={cn(outcome === "failed" && "text-err")} />;
}

/**
 * One exchange as a row (decision 93 d). Collapsed: outcome glyph, the request on one line, its time at the right, and the
 * first line of the answer dim under it. Open (one at a time, the list owns which): the whole request when the row cut it,
 * the answer in compact prose, a failure's next step, one meta line that never wraps, and "Open in conversation" at its
 * end when there is room. The "⋯" holds Open in conversation, Context (the receipt, a popover) and Forget.
 */
export function ExchangeRow(props: {
  projectId: string;
  exchange: MemoryExchange;
  now: number;
  open: boolean;
  /** Shown because a search hit asked for it: scrolled to once. */
  reveal: boolean;
  onToggle(): void;
  onClose(): void;
  onOpenMessage?: ((turnId: number) => void) | undefined;
  onForget(id: string): Promise<void>;
}) {
  const e = props.exchange;
  const { name } = useModelNames();
  const { box, onKeyDown } = useCollapseOnEscape(props.open, props.onClose);
  const anchor = useRef<HTMLDivElement>(null);
  const [receipt, setReceipt] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useReveal(box, props.reveal);
  if (e.removed) {
    return (
      <li data-exchange={e.id}>
        {/* B32: the glyph column and the time column of the other exchanges, so the text edge does not jump. */}
        <ListRow size="md" tone="quiet" leading={<Glyph icon={Eraser} size={14} />} title="Forgotten request" meta="removed" />
      </li>
    );
  }
  const row = exchangeRow(e, props.now);
  const note = statusNote(e.status);
  const line = metaLine(metaParts(e, e.model ? name(e.model) : "", props.now));
  const open = props.onOpenMessage;
  return (
    // The key handler reaches rows inside the list; the row's own button is the focusable element.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the open row from anywhere inside it
    <li ref={box} data-exchange={e.id} onKeyDown={onKeyDown} className={cn(props.open && "mb-1 rounded-sm bg-active")}>
      <div ref={anchor}>
        <ListRow
          size="md"
          expanded={props.open}
          leading={<OutcomeGlyph outcome={row.outcome} />}
          title={
            <>
              <span className="sr-only">{OUTCOME_LABEL[row.outcome]}: </span>
              {row.title}
            </>
          }
          description={<RowLine end={row.when}>{row.description}</RowLine>}
          tip={e.request.trim()}
          onClick={props.onToggle}
          trailing={
            <IconMenu
              label="Request actions"
              size="xs"
              items={[
                ...(open ? [{ id: "open", label: "Open in session", run: () => open(e.turn_id) }] : []),
                { id: "context", label: "Context", run: () => setReceipt(true) },
                { id: "forget", label: "Forget this request", run: () => setConfirm(true) },
              ]}
            />
          }
        />
      </div>
      {props.open && (
        <Expansion>
          {needsFullRequest(e.request) && (
            <p className="border-l-2 border-line-strong pl-3 text-sm break-words whitespace-pre-wrap text-fg-2">{e.request.trim()}</p>
          )}
          {e.answer.trim() !== "" && <Prose size="compact" text={e.answer} />}
          {note && (
            <p className="flex min-w-0 gap-2 text-sm text-fg-2">
              <Glyph
                icon={e.status === "failed" ? CircleAlert : CirclePause}
                size={14}
                className={cn("mt-0.5 shrink-0", e.status === "failed" && "text-err")}
              />
              <span className="min-w-0 break-words">{note}</span>
            </p>
          )}
          {e.answer_truncated && <Notice tone="info">The answer was longer than 64 KB; the end is cut.</Notice>}
          <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
            <span className="min-w-0 flex-1 truncate" title={line}>
              {line}
            </span>
            {open && (
              <Button variant="quiet" size="xs" icon={MessageSquareShare} className="shrink-0 @max-[380px]/ex:hidden" onClick={() => open(e.turn_id)}>
                Open in conversation
              </Button>
            )}
          </div>
        </Expansion>
      )}
      <Presence show={receipt}>
        <ReceiptPopover anchor={anchor} projectId={props.projectId} turnId={e.turn_id} onClose={() => setReceipt(false)} />
      </Presence>
      {confirm && (
        <ConfirmDialog
          title="Forget this request?"
          description="The request and its answer are removed from memory and search. The session keeps a marker. This can't be undone."
          confirm="Forget"
          busyText="Forgetting"
          onClose={() => setConfirm(false)}
          onConfirm={() => props.onForget(e.id)}
        />
      )}
    </li>
  );
}
