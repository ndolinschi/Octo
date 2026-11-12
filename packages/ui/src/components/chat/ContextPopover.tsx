import type { ContextBreakdown, ContextOverview } from "@octo/agent-client";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { compactedLine, compactError } from "../../lib/compactNow";
import { cacheLine, contextHeadline, contextView, lastTurnView, type ContextView } from "../../lib/contextView";
import { errorCode, errorMessage, formatTokens } from "../../lib/format";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { requestMemoryView } from "../../state/workspace/tabMemory";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { Spinner } from "../primitives/Status";

/** The context button's popover (decision 65), its own chunk: it loads when the button is first opened. */
export function ContextPopover(props: { anchor: React.RefObject<HTMLButtonElement | null>; used: number; size: number; onClose(): void }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  const [view, setView] = useState<ContextView>(() => lastTurnView(props.used, props.size));
  const [loading, setLoading] = useState(Boolean(bridge.getContextOverview));
  const [compacting, setCompacting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!bridge.getContextOverview) return;
    bridge.getContextOverview(projectId).then(
      (raw: ContextOverview | ContextBreakdown) => {
        setView(contextView(raw));
        setLoading(false);
      },
      // The numbers stay as they were (the last turn's); the popover says nothing more than it knew.
      () => setLoading(false),
    );
  }, [bridge, projectId]);
  useEffect(load, [load]);
  // Parity B7: a turn, a compaction, a rewind, a note or an instruction file changed what the next request holds.
  const { onEvent } = useProject();
  useEffect(() => onEvent((e) => e.type === "context.updated" && load()), [onEvent, load]);
  const a = view.approx ? "≈" : "";
  const cache = cacheLine(view);
  const compact = bridge.compactNow;
  return (
    <Popover anchor={props.anchor} label="Context" side="top" align="end" onClose={props.onClose} className="w-[min(340px,calc(100vw-16px))]">
      <div className="flex flex-col gap-3 p-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <p className="text-heading text-fg">{contextHeadline(view)}</p>
          {view.compacted && <p className="text-xs text-fg-3">{view.compacted}</p>}
          {view.fromLastTurn && <p className="text-xs text-fg-3">From the last turn.</p>}
        </div>
        {view.source === "agent" ? (
          <p className="text-fg-2">This agent manages its own context. Octo shows what it reports.</p>
        ) : (
          view.rows.length > 0 && (
            <>
              <div
                role="meter"
                aria-label="Context used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={view.usedPercent ?? 0}
                className="flex h-1.5 overflow-hidden rounded-full bg-line"
              >
                {view.rows
                  .filter((r) => r.kind !== "free")
                  .map((r) => (
                    <span
                      key={r.id}
                      className={cn(
                        "h-full",
                        r.kind === "reserved" ? "bg-line-strong" : `octo-ctx-${r.id}`,
                        r.kind === "category" && !CTX_IDS.has(r.id) && "bg-fg-3",
                      )}
                      style={{ width: `${r.percent}%` }}
                    />
                  ))}
              </div>
              <ul className="flex flex-col">
                {view.rows.map((r) => (
                  <li key={r.id} data-context-part={r.id} className="flex h-row items-center gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-2xs",
                        r.kind === "free"
                          ? "border border-line-strong"
                          : r.kind === "reserved"
                            ? "bg-line-strong"
                            : CTX_IDS.has(r.id)
                              ? `octo-ctx-${r.id}`
                              : "bg-fg-3",
                      )}
                    />
                    <span className={cn("min-w-0 flex-1 truncate", r.kind === "free" ? "text-fg-3" : "text-fg-2")}>{r.label}</span>
                    <span className="shrink-0 font-mono text-xs text-fg-2 tabular-nums">
                      {a}
                      {formatTokens(r.tokens)}
                    </span>
                    <span className="w-9 shrink-0 text-right font-mono text-xs text-fg-3 tabular-nums">{r.percent}%</span>
                  </li>
                ))}
              </ul>
            </>
          )
        )}
        {loading && (
          <p className="flex items-center gap-2 text-xs text-fg-3">
            <Spinner /> Reading the context…
          </p>
        )}
        {cache && <p className="text-xs text-fg-3">{cache}</p>}
        {note && (
          <p role="status" className="text-xs text-fg-2">
            {note}
          </p>
        )}
        <div className="flex items-center gap-2">
          {compact && view.source === "harness" && (
            <Button
              size="sm"
              variant="secondary"
              disabled={compacting}
              onClick={() => {
                setCompacting(true);
                setNote(null);
                compact.call(bridge, projectId).then(
                  (result) => {
                    setCompacting(false);
                    // The marker in the transcript comes with `agent.compacted`; the numbers with `context.updated`.
                    setNote(compactedLine(result));
                    load();
                  },
                  (e: unknown) => {
                    setCompacting(false);
                    setNote(compactError(errorCode(e)) ?? `Could not compact: ${errorMessage(e).replace(/\.$/, "")}. Try again.`);
                  },
                );
              }}
            >
              {compacting && <Spinner />}
              Compact now
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={!ws}
            onClick={() => {
              // An already-mounted Memory tab is told too (it reads the request once on mount otherwise).
              if (ws) requestMemoryView(ws.memory, "context");
              ws?.openTool("memory");
              props.onClose();
            }}
          >
            Open context details
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/** The parts that have a colour in styles.css (`octo-ctx-<id>`); any other category is drawn neutral. */
const CTX_IDS = new Set(["messages", "tool_results", "summary", "notes", "tools", "system"]);
