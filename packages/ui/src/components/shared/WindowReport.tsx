import type { ContextBreakdown, ContextOverview } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { cacheLine, contextHeadline, contextKey } from "../../lib/contextView";
import { cn } from "../../lib/cn";
import { errorMessage, formatTokens } from "../../lib/format";
import { foldItems, windowReportView, type OpenTarget, type ReportItem, type WindowReportView } from "../../lib/windowReport";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonText } from "../primitives/Skeleton";

/** Every row reserves the width of its "Open" button, so the numbers of all rows end on one edge. */
const TAIL = <span aria-hidden className="w-12" />;

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; report: WindowReportView };

/**
 * The context window report (what `/context` and the context ring's popover show), as a sheet over whatever is open
 * (decision 93 c: Context is not a Memory view; decision 88: itemised). The headline, one row per category with its
 * tokens and share and, under it, what is inside (the five largest rows, "Show all N" for the rest); "Not loaded": what
 * could be in the window and is not, with what loading would add; "Largest messages": the five biggest, each with Open.
 * Hosts pass what only they can do: `onOpenFile` (a project file), `onOpenMemoryFile` (a memory file), `onOpenMessage` (a
 * request in the chat). Without a handler its "Open" is left out.
 */
export function WindowReport(props: {
  onClose(): void;
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenMemoryFile?: ((path: string) => void) | undefined;
  onOpenMessage?: ((messageId: number) => void) | undefined;
}) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [all, setAll] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const get = bridge.getContextOverview ?? bridge.getContext;
    let live = true;
    get.call(bridge, projectId).then(
      (raw: ContextOverview | ContextBreakdown) => live && setLoad({ status: "ok", report: windowReportView(raw) }),
      (e: unknown) => live && setLoad({ status: "error", message: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [bridge, projectId]);
  const report = load.status === "ok" ? load.report : null;
  const view = report?.view ?? null;
  const approx = view?.approx ? "≈" : "";
  const toggle = (id: string) =>
    setAll((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const opener = useMemo(
    () =>
      (t: OpenTarget | null): (() => void) | null => {
        if (!t) return null;
        if (t.to === "memory-file") return props.onOpenMemoryFile ? () => props.onOpenMemoryFile?.(t.path) : null;
        return props.onOpenFile ? () => props.onOpenFile?.(t.path) : null;
      },
    [props.onOpenFile, props.onOpenMemoryFile],
  );
  const itemRow = (i: ReportItem, prefix: string) => {
    const open = opener(i.open);
    return (
      <li key={i.id}>
        <ListRow
          size="sm"
          tone="quiet"
          title={i.title}
          tip={i.title}
          meta={
            <span className="tabular-nums">
              {prefix}
              {approx}
              {formatTokens(i.tokens)}
            </span>
          }
          trailing={
            open ? (
              <Button variant="quiet" size="xs" className="w-12 px-0" onClick={open}>
                Open
              </Button>
            ) : (
              TAIL
            )
          }
        />
      </li>
    );
  };
  return (
    <Dialog
      title="Context window"
      {...(view ? { description: contextHeadline(view) } : {})}
      onClose={props.onClose}
      footer={
        <Button variant="quiet" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      {load.status === "loading" && <SkeletonText lines={5} />}
      {load.status === "error" && <Notice tone="error">{load.message} Close this and open it again to retry.</Notice>}
      {view?.source === "agent" && <p className="text-sm text-fg-2">This agent manages its own context. Octo shows what it reports.</p>}
      {report && report.sections.length > 0 && view?.source !== "agent" && (
        <div
          role="meter"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view?.usedPercent ?? 0}
          className="mb-2 flex h-2 overflow-hidden rounded-full bg-line"
        >
          {[...report.sections.filter((s) => s.kind !== "free"), ...report.sections.filter((s) => s.kind === "free")].map((s) => (
            <span key={s.id} className={cn("h-full", contextKey(s).segment)} style={{ width: `${s.percent}%` }} />
          ))}
        </div>
      )}
      {report && report.sections.length > 0 && (
        <ul className="-mx-2 flex flex-col">
          {report.sections.map((s) => {
            const { shown, hidden } = foldItems(s.items, all.has(s.id));
            return (
              <li key={s.id}>
                <ListRow
                  title={s.label}
                  leading={<span className={cn("size-2 rounded-2xs", contextKey(s).key)} />}
                  trailing={TAIL}
                  tone={s.kind === "free" ? "quiet" : "default"}
                  meta={
                    <span className="tabular-nums">
                      {approx}
                      {formatTokens(s.tokens)} · {s.percent}%
                    </span>
                  }
                />
                {s.items.length > 0 && (
                  <ul aria-label={`${s.label}: what is inside`} className="flex flex-col pl-4">
                    {shown.map((i) => itemRow(i, ""))}
                    {(hidden > 0 || all.has(s.id)) && (
                      <li>
                        <ListRow
                          size="sm"
                          tone="quiet"
                          expanded={all.has(s.id)}
                          title={all.has(s.id) ? "Show fewer" : `Show all ${s.items.length}`}
                          onClick={() => toggle(s.id)}
                        />
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
          {report.buffer !== null && (
            <li>
              <ListRow
                title="Compaction buffer"
                trailing={TAIL}
                tone="quiet"
                meta={
                  <span className="tabular-nums">
                    {approx}
                    {formatTokens(report.buffer)}
                  </span>
                }
              />
            </li>
          )}
        </ul>
      )}
      {report && report.notLoaded.length > 0 && (
        <section aria-label="Not loaded" className="pt-3">
          <SectionHeader as="h3" inset className="-mx-2">
            Not loaded
          </SectionHeader>
          <p className="pb-1 text-xs text-fg-3">What could be in the window and is not. The number is what loading it would add.</p>
          <ul className="-mx-2 flex flex-col">
            {foldItems(report.notLoaded, all.has("not_loaded")).shown.map((i) => itemRow(i, "+"))}
            {(foldItems(report.notLoaded, false).hidden > 0 || all.has("not_loaded")) && (
              <li>
                <ListRow
                  size="sm"
                  tone="quiet"
                  expanded={all.has("not_loaded")}
                  title={all.has("not_loaded") ? "Show fewer" : `Show all ${report.notLoaded.length}`}
                  onClick={() => toggle("not_loaded")}
                />
              </li>
            )}
          </ul>
        </section>
      )}
      {report && report.largest.length > 0 && (
        <section aria-label="Largest messages" className="pt-3">
          <SectionHeader as="h3" inset className="-mx-2">
            Largest messages
          </SectionHeader>
          <ul className="-mx-2 flex flex-col">
            {report.largest.map((m) => (
              <li key={m.messageId}>
                <ListRow
                  size="sm"
                  tone="quiet"
                  title={`${m.roleLabel}: ${m.preview}`}
                  tip={m.preview}
                  meta={
                    <span className="tabular-nums">
                      {approx}
                      {formatTokens(m.tokens)}
                    </span>
                  }
                  trailing={
                    props.onOpenMessage ? (
                      <Button variant="quiet" size="xs" className="w-12 px-0" onClick={() => props.onOpenMessage?.(m.messageId)}>
                        Open
                      </Button>
                    ) : (
                      TAIL
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {view && cacheLine(view) && <p className="pt-2 text-xs text-fg-3">{cacheLine(view)}</p>}
    </Dialog>
  );
}
