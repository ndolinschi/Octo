import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { truncateDistinct } from "../../lib/models";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { bucketTokens, daysWithData, fillDays, mergeBy, shareRows, type ShareRow } from "../../lib/usage";
import type { UsageView } from "../../lib/usageView";
import { DayBars } from "../primitives/DayBars";
import { INFO_ROW, InfoSection, SkeletonRows } from "../primitives/InfoList";
import { useModelNames } from "../../state/models";
import { roleText } from "../../lib/orchestrator";
import type { Load, UsageData } from "./useUsage";

/** Height of the daily chart (px). */
const CHART = 64;

export function dayLabel(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Loading / error / empty, in one place for the three segments. */
export function UsageState({ load, empty, children }: { load: Load<UsageData>; empty: boolean; children: React.ReactNode }) {
  if (load.status === "loading") return <SkeletonRows count={6} />;
  if (load.status === "error")
    return (
      <p role="alert" className="px-2 text-sm text-fg-2">
        Couldn't read usage: {load.message}. Check that the harness is running, then reopen this tab.
      </p>
    );
  if (empty)
    return (
      <div className="flex flex-col gap-1 px-2 py-6 text-center">
        <p className="text-sm text-fg-2">No usage in this range</p>
        <p className="text-xs text-fg-3">Tokens appear here after the orchestrator or an agent gets a model response.</p>
      </div>
    );
  return <>{children}</>;
}

/** Proportional breakdown rows: label, a 2px bar against the largest row, the value in tabular numerals. */
/** Average advance of a 13px UI glyph (px), to turn the label column's width into a character budget. */
const CHAR_PX = 6.8;

/**
 * Breakdown rows on one grid (label, bar, value). `distinct` (model names, decision 37): labels that do not fit lose
 * their middle, never the tail that tells two similar ids apart ("deepseek-v4.1-fl…sh-0905" vs "…sh-1120"); the full name
 * is in the row's tooltip.
 */
export function ShareRows({
  rows,
  value,
  title,
  distinct = false,
}: {
  rows: ShareRow[];
  value(r: ShareRow): React.ReactNode;
  title(r: ShareRow): string;
  distinct?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !distinct) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [distinct]);
  const labels = useMemo(
    () =>
      distinct && width > 0
        ? truncateDistinct(
            rows.map((r) => r.label),
            Math.max(8, Math.floor((width * 0.4 - 16) / CHAR_PX)),
          )
        : rows.map((r) => r.label),
    [rows, distinct, width],
  );
  return (
    <div ref={box} className="flex flex-col">
      {rows.map((r, i) => (
        <div key={r.key} className={INFO_ROW} title={title(r)}>
          <span className="w-[40%] min-w-0 shrink-0 truncate text-fg-2">{labels[i] ?? r.label}</span>
          <span aria-hidden className="h-0.5 min-w-0 flex-1 rounded-full bg-line">
            <span className="block h-full rounded-full bg-fg-3" style={{ width: `${Math.max(2, r.share * 100)}%` }} />
          </span>
          <span className="shrink-0 text-xs text-fg-2 tabular-nums">{value(r)}</span>
        </div>
      ))}
    </div>
  );
}

function Figure({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="text-sm text-fg tabular-nums" title={value.toLocaleString()}>
        {formatTokens(value)}
      </dd>
    </div>
  );
}

export function UsageTokens({ load, view, now }: { load: Load<UsageData>; view: UsageView; now: number }) {
  const data = load.status === "ok" ? load.value : null;
  const { name: modelLabel } = useModelNames();
  const days = useMemo(() => fillDays(data?.days ?? null, view.days, now), [data, view.days, now]);
  const total = data ? bucketTokens(data.models.total) : 0;
  const models = useMemo(() => (data ? shareRows(data.models.buckets.map((b) => ({ ...b, label: modelLabel(b.label || b.key) }))) : []), [data, modelLabel]);
  const breakdown = useMemo(
    () => (data ? shareRows(view.scope === "project" ? mergeBy(data.breakdown.buckets, (b) => roleText(b.label)) : data.breakdown.buckets) : []),
    [data, view.scope],
  );
  const t = data?.models.total;
  return (
    <UsageState load={load} empty={total === 0}>
      {t && (
        <section aria-label="Totals" className="flex flex-col gap-3 px-2">
          <p className="text-figure text-fg tabular-nums">
            {formatTokens(total)}
            <span className="ml-2 text-sm font-normal text-fg-3">tokens</span>
          </p>
          <dl className="grid grid-cols-4 gap-3 @max-[320px]/usage:grid-cols-2">
            <Figure label="In" value={t.input_tokens} />
            <Figure label="Out" value={t.output_tokens} />
            <Figure label="Cache read" value={t.cache_read_tokens} />
            <Figure label="Cache write" value={t.cache_write_tokens} />
          </dl>
        </section>
      )}
      <section aria-label="Tokens per day" className="px-2 pt-1">
        {daysWithData(days) >= 2 ? (
          <DayBars
            label={`Tokens per day, last ${view.days} days`}
            height={CHART}
            ticks={[dayLabel(days[0]?.key ?? ""), dayLabel(days[days.length - 1]?.key ?? "")]}
            days={days.map((d) => ({
              key: d.key,
              value: d.total,
              text: d.total
                ? `${dayLabel(d.key)}: ${formatTokens(d.total)} tokens, ${formatTokens(d.input)} in, ${formatTokens(d.output)} out, ${d.requests} ${d.requests === 1 ? "response" : "responses"}`
                : `${dayLabel(d.key)}: no usage`,
            }))}
            summary={`${daysWithData(days)} of ${view.days} days with usage`}
          />
        ) : (
          // One day is not a trend: say what there is instead of drawing a lone bar.
          <p className="text-xs text-fg-3">
            {daysWithData(days) === 1
              ? `All of it on ${dayLabel(days.find((d) => d.total > 0)?.key ?? "")}; the daily chart appears once a second day has usage.`
              : "No daily usage in this range."}
          </p>
        )}
      </section>
      <InfoSection title="By model" labelId="usage-models">
        <ShareRows distinct rows={models} value={(r) => formatTokens(r.tokens)} title={(r) => `${r.key}: ${r.tokens.toLocaleString()} tokens`} />
      </InfoSection>
      <InfoSection title={view.scope === "project" ? "By agent" : "By project"} labelId="usage-breakdown">
        <ShareRows
          rows={breakdown}
          value={(r) => formatTokens(r.tokens)}
          title={(r) => `${r.label}: ${r.tokens.toLocaleString()} tokens in ${r.bucket.requests} responses`}
        />
      </InfoSection>
    </UsageState>
  );
}
