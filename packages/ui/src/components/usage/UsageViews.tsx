import { useMemo } from "react";
import type { UsageReport } from "@octo/agent-client";
import { formatTokens } from "../../lib/format";
import { roleText } from "../../lib/orchestrator";
import { bucketTokens, daysWithData, fillDays, mergeBy } from "../../lib/usage";
import { chartDays, periodText, placeRoles, usageRows } from "../../lib/usage/model";
import type { UsageView } from "../../lib/usageView";
import { useModelNames } from "../../state/models";
import { useProject } from "../../state/project";
import { DayBars } from "../primitives/DayBars";
import { EmptyState } from "../primitives/EmptyState";
import { Notice } from "../primitives/Notice";
import { SkeletonList } from "../primitives/Skeleton";
import { UsageTable, type UsageTableRow } from "../shared/UsageTable";
import type { Load, UsageData } from "./useUsage";

/** Height of the daily chart (px). */
const CHART = 64;

export function dayLabel(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Loading / error / empty, in one place for the views. */
function UsageState({ load, empty, children }: { load: Load<UsageData>; empty: boolean; children: React.ReactNode }) {
  if (load.status === "loading") return <SkeletonList count={6} size="md" />;
  if (load.status === "error")
    return (
      <Notice form="block" tone="error" title="Couldn't read usage">
        {load.message}. Check that the harness is running, then reopen this tab.
      </Notice>
    );
  if (empty) return <EmptyState title="No usage in this range">Tokens appear here after a request or an agent gets a model response.</EmptyState>;
  return <>{children}</>;
}

const hasUsage = (r: UsageReport) => r.buckets.some((b) => bucketTokens(b) > 0);
const countNote = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** By model (decision 86 a): one row per model; with `roles` the roles that ran on each model sit under it. */
export function UsageByModel({ load, view }: { load: Load<UsageData>; view: UsageView }) {
  const { name } = useModelNames();
  const { state } = useProject();
  const data = load.status === "ok" ? load.value : null;
  const placed = useMemo(() => {
    if (!data) return { rows: [] as UsageTableRow[], unplaced: [] };
    const models = usageRows(data.models.buckets, (b) => name(b.label || b.key));
    if (!view.roles || view.scope !== "project") return { rows: models as UsageTableRow[], unplaced: [] };
    // The harness has no model x role report: an agent's role goes under the model its agent record names.
    const modelOf = (id: string) => {
      const a = state.agents[id];
      return a ? (a.served_model ?? a.model) : null;
    };
    const { rows, unplaced } = placeRoles(models, data.breakdown.buckets, modelOf, (b) => roleText(b.label));
    return { rows: rows.map((r) => ({ ...r, nested: r.roles })), unplaced };
  }, [data, name, state.agents, view.roles, view.scope]);
  return (
    <UsageState load={load} empty={!data || !hasUsage(data.models)}>
      <UsageTable
        first="Model"
        label={`Tokens per model, ${periodText(view.period).toLowerCase()}`}
        rows={placed.rows}
        note={`${countNote(placed.rows.length, "model", "models")}, ${view.scope === "project" ? "this project" : "all projects"}`}
        footer={
          placed.unplaced.length > 0 && (
            <p className="px-2 text-xs text-fg-3">
              Roles without a known model: {placed.unplaced.map((r) => `${r.label} ${formatTokens(r.total)}`).join(", ")}.
            </p>
          )
        }
      />
    </UsageState>
  );
}

/** By agent (one project: rows merged by role) or By project (all projects). */
export function UsageByAgent({ load, view }: { load: Load<UsageData>; view: UsageView }) {
  const data = load.status === "ok" ? load.value : null;
  const rows = useMemo(() => {
    if (!data) return [];
    return view.scope === "project" ? usageRows(mergeBy(data.breakdown.buckets, (b) => roleText(b.label))) : usageRows(data.breakdown.buckets);
  }, [data, view.scope]);
  const first = view.scope === "project" ? "Agent" : "Project";
  return (
    <UsageState load={load} empty={!data || !hasUsage(data.breakdown)}>
      <UsageTable
        first={first}
        label={`Tokens per ${first.toLowerCase()}`}
        rows={rows}
        note={countNote(rows.length, first.toLowerCase(), `${first.toLowerCase()}s`)}
      />
    </UsageState>
  );
}

/** By day: the daily chart over the period, and the days that have usage, newest first. */
export function UsageByDay({ load, view, now }: { load: Load<UsageData>; view: UsageView; now: number }) {
  const data = load.status === "ok" ? load.value : null;
  const first = data?.days.buckets.map((b) => b.key).sort()[0] ?? null;
  const span = chartDays(view.period, first, now);
  const days = useMemo(() => fillDays(data?.days ?? null, span, now), [data, span, now]);
  const rows = useMemo(() => (data ? usageRows(data.days.buckets, (b) => dayLabel(b.key), "key-desc") : []), [data]);
  return (
    <UsageState load={load} empty={!data || !hasUsage(data.days)}>
      <section aria-label="Tokens per day" className="px-2 pt-1">
        {daysWithData(days) >= 2 ? (
          <DayBars
            label={`Tokens per day, last ${span} days`}
            height={CHART}
            ticks={[dayLabel(days[0]?.key ?? ""), dayLabel(days[days.length - 1]?.key ?? "")]}
            days={days.map((d) => ({
              key: d.key,
              value: d.total,
              text: d.total
                ? `${dayLabel(d.key)}: ${formatTokens(d.total)} tokens, ${formatTokens(d.input)} in, ${formatTokens(d.output)} out, ${d.requests} ${d.requests === 1 ? "response" : "responses"}`
                : `${dayLabel(d.key)}: no usage`,
            }))}
            summary={`${daysWithData(days)} of ${span} days with usage`}
          />
        ) : (
          // One day is not a trend: say what there is instead of drawing a lone bar.
          <p className="text-xs text-fg-3">The daily chart appears once a second day has usage.</p>
        )}
      </section>
      <UsageTable
        first="Day"
        label={`Tokens per day, ${periodText(view.period).toLowerCase()}`}
        rows={rows}
        note={countNote(rows.length, "day with usage", "days with usage")}
      />
    </UsageState>
  );
}
