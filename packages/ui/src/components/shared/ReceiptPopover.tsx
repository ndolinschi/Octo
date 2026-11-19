import type { ContextReceipt } from "@octo/agent-client";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { errorMessage, formatTokens } from "../../lib/format";
import { isNotFound, type Load } from "../../lib/memory/load";
import { blockColor, countText, receiptView } from "../../lib/memory/receipt";
import { useApp } from "../../state/app";
import { ListRow } from "../primitives/ListRow";
import { Popover } from "../primitives/Popover";
import { SkeletonText } from "../primitives/SkeletonText";

/** `none` is a turn without a receipt (it ran before receipts existed): an empty state, not an error. */
type ReceiptLoad = Load<ContextReceipt> | { status: "none" };
type Settled = { key: string; load: ReceiptLoad };

function useReceipt(projectId: string, turnId: number): ReceiptLoad {
  const { bridge } = useApp();
  const key = `${projectId}|${turnId}`;
  const [settled, setSettled] = useState<Settled | null>(null);
  const get = bridge.getTurnContext;
  useEffect(() => {
    if (!get) return;
    let live = true;
    get.call(bridge, projectId, turnId).then(
      (value) => live && setSettled({ key, load: { status: "ok", value } }),
      (e: unknown) => live && setSettled({ key, load: isNotFound(e) ? { status: "none" } : { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      live = false;
    };
  }, [bridge, get, projectId, turnId, key]);
  return settled?.key === key ? settled.load : { status: "loading" };
}

/**
 * What the orchestrator had in front of it for one request (its context receipt), as a popover under the exchange
 * (decision 93 c). One line per block: its name, the tokens it took, and what it carried in words ("3 open tasks"); never ids.
 */
export function ReceiptPopover(props: { anchor: RefObject<HTMLElement | null>; projectId: string; turnId: number; onClose(): void }) {
  const load = useReceipt(props.projectId, props.turnId);
  const view = useMemo(() => (load.status === "ok" ? receiptView(load.value) : null), [load]);
  return (
    <Popover anchor={props.anchor} label="Context for this request" align="end" onClose={props.onClose} className="w-[min(360px,calc(100vw-16px))]">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
        <div className="flex flex-col">
          <p className="text-heading text-fg">Context for this request</p>
          <p className="text-xs text-fg-3">{view ? view.modeText : "What the model read"}</p>
        </div>
        {load.status === "loading" && <SkeletonText lines={4} />}
        {load.status === "error" && <p className="text-sm text-fg-2">{load.message} Close this and open it again to retry.</p>}
        {load.status === "none" && (
          <p className="text-sm text-fg-2">No record for this request: it ran before records were kept, or it hasn&apos;t started yet.</p>
        )}
        {view && (
          <>
            <div
              role="img"
              aria-label={`${view.totalText}. ${view.segments.map((s) => `${s.label} ${formatTokens(s.tokens)}`).join(", ")}`}
              className="flex h-2 w-full gap-px overflow-hidden rounded-xs bg-hover"
            >
              {view.segments
                .filter((s) => s.tokens > 0)
                .map((s) => (
                  <span
                    key={s.name}
                    className="h-full min-w-0.5 shrink-0"
                    style={{ width: `${(s.share * 100).toFixed(2)}%`, background: blockColor(s.name) }}
                  />
                ))}
            </div>
            <p className="text-sm text-fg-2">{view.totalText}</p>
            <ul className="-mx-2 flex flex-col">
              {view.segments.map((s) => (
                <li key={s.name}>
                  <ListRow
                    size="md"
                    leading={<span className="size-2 rounded-2xs" style={{ background: blockColor(s.name) }} />}
                    title={s.label}
                    meta={<span className="tabular-nums">{formatTokens(s.tokens)}</span>}
                    description={`${countText(s.name, s.count)}${s.capped ? ", at its limit" : ""}`}
                  />
                </li>
              ))}
            </ul>
            {view.clearedText && <p className="text-xs text-fg-3">{view.clearedText}.</p>}
          </>
        )}
      </div>
    </Popover>
  );
}
