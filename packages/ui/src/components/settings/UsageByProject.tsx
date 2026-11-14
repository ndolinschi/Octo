import type { UsageReport } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useDelayedLoading } from "../../lib/hooksMore";
import { periodRange, usageRows, USAGE_PERIODS } from "../../lib/usage/model";
import { SESSION_STARTED_AT, type UsagePeriod } from "../../lib/usageView";
import { useApp } from "../../state/app";
import { useModelNames } from "../../state/modelNames";
import { Notice } from "../primitives/Notice";
import { Select } from "../primitives/Select";
import { UsageTable, UsageTableSkeleton, type UsageTableRow } from "../shared/UsageTable";
import { SELECT_W, SettingsGroup, SettingsRow } from "./parts";

const DAY_MS = 86_400_000;

type Models = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; report: UsageReport };

/**
 * Decision 86 c: Settings → Usage and budget — tokens, requests and cost for all projects, one row per project that
 * opens to its models (read when opened, `group=model&project=`). Same table as the Usage tab.
 */
export function UsageByProject({ holdFooter, onSettled }: { holdFooter: boolean; onSettled(settled: boolean): void }) {
  const { bridge, projects } = useApp();
  const { name } = useModelNames();
  const [period, setPeriod] = useState<UsagePeriod>("all");
  const [report, setReport] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: UsageReport }>({
    status: "loading",
  });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [models, setModels] = useState<Record<string, Models>>({});
  // Re-read when the UTC day turns, not every minute: every period but "session" is bounded by whole days.
  const day = Math.floor(useNow(false, CLOCK_MINUTE_MS) / DAY_MS);
  const range = useMemo(() => periodRange(period, day * DAY_MS, SESSION_STARTED_AT), [period, day]);
  const pick = (p: UsagePeriod) => {
    setPeriod(p);
    setModels({});
  };
  useEffect(() => {
    let live = true;
    bridge.getUsage({ ...range, group: "project" }).then(
      (value) => {
        if (!live) return;
        setReport({ status: "ok", value });
        onSettled(true);
      },
      (e: unknown) => {
        if (!live) return;
        setReport({ status: "error", message: errorMessage(e) });
        onSettled(true);
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, range, onSettled]);
  const slow = useDelayedLoading(report.status === "loading");
  const toggle = (id: string) => {
    const opening = !open.has(id);
    setOpen((s) => {
      const next = new Set(s);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!opening || models[id]?.status === "ok") return;
    setModels((m) => ({ ...m, [id]: { status: "loading" } }));
    bridge.getUsage({ ...range, group: "model", project: id }).then(
      (r) => setModels((m) => ({ ...m, [id]: { status: "ok", report: r } })),
      (e: unknown) => setModels((m) => ({ ...m, [id]: { status: "error", message: errorMessage(e) } })),
    );
  };
  const rows: UsageTableRow[] = useMemo(() => {
    if (report.status !== "ok") return [];
    return usageRows(report.value.buckets).map((r) => {
      const m = models[r.key];
      const isOpen = open.has(r.key);
      return {
        ...r,
        expandable: true,
        open: isOpen,
        ...(isOpen && m?.status === "ok" ? { nested: usageRows(m.report.buckets, (b) => name(b.label || b.key)) } : {}),
        ...(isOpen && (!m || m.status === "loading") ? { nestedNote: "Reading models…" } : {}),
        ...(isOpen && m?.status === "error" ? { nestedNote: `Couldn't read this project's models: ${m.message}. Close the row and open it again.` } : {}),
      };
    });
  }, [report, models, open, name]);
  const empty = report.status === "ok" && rows.length === 0;
  return (
    <SettingsGroup
      label="Usage by project"
      id="row-usage"
      footer={holdFooter ? undefined : "Tokens as each model reported them. A project on a subscription shows what it would have cost, not spend."}
    >
      <SettingsRow
        title="Period"
        htmlFor="usage-period"
        control={
          <div className={SELECT_W}>
            <Select
              id="usage-period"
              label="Period"
              value={period}
              options={USAGE_PERIODS.map((p) => ({ value: p.id, label: p.label }))}
              onChange={(v) => {
                const next = USAGE_PERIODS.find((p) => p.id === v);
                if (next) pick(next.id);
              }}
            />
          </div>
        }
      />
      <div className="px-1 py-1">
        {/* Not for a fast answer (no flash); the rows' own height, one per project the app knows. Nothing under the table is shown
            until it has answered (`holdFooter`, UsageSection), so the real rows replacing these move nothing. */}
        {report.status === "loading" && slow && <UsageTableSkeleton first="Project" rows={Math.min(Math.max(projects?.length ?? 3, 1), 8)} />}
        {report.status === "error" && (
          <Notice tone="error" className="p-2">
            Couldn&apos;t read usage: {report.message}. Check that Octo&apos;s local service is running, then reopen Settings.
          </Notice>
        )}
        {empty && <p className="px-2 py-2 text-sm text-fg-3">No usage in this period. Tokens appear here after a project gets a model response.</p>}
        {report.status === "ok" && !empty && (
          <UsageTable
            first="Project"
            label="Usage per project"
            rows={rows}
            onToggle={toggle}
            note={`${rows.length} ${rows.length === 1 ? "project" : "projects"}`}
          />
        )}
      </div>
    </SettingsGroup>
  );
}
