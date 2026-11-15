import { useState, useRef } from "react";
import { useQuietOpen } from "../../lib/quietFocus";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { USAGE_PERIODS } from "../../lib/usage/model";
import { DEFAULT_USAGE_VIEW, type UsageSegment, type UsageView } from "../../lib/usageView";
import { toolTab } from "../../state/workspace/layout";
import { USAGE_VIEW } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Panel, PanelBody, PanelEmpty, PanelFilters } from "../primitives/Panel";
import { Select } from "../primitives/Select";
import { UsageLimits } from "./UsageLimits";
import { UsageByAgent, UsageByDay, UsageByModel, usageEmpty } from "./UsageViews";
import { useUsageReports } from "./useUsage";
import { ViewTabs } from "../primitives/ViewTabs";
import { PanelPurpose } from "../shared/PanelPurpose";
import { PANEL_COLUMN } from "../../lib/panelColumn";

const TAB = toolTab("usage");

/**
 * The Usage tab (decision 86): By model · By agent · By day · Limits as view tabs (decision 82), the period and scope in
 * a row of `Select`s above the table. Everything comes from `getUsage` and `getLimits`; unknown cost reads "no price" and a
 * subscription's usage reads "≈ $X on your subscription". The controls are remembered per tab.
 */
export function UsagePanel() {
  const ws = useWorkspace();
  const [view, setViewState] = useState<UsageView>(() => ws.memory.get(TAB, USAGE_VIEW) ?? DEFAULT_USAGE_VIEW);
  const setView = (patch: Partial<UsageView>) =>
    setViewState((v) => {
      const next = { ...v, ...patch };
      ws.memory.set(TAB, USAGE_VIEW, next);
      return next;
    });
  const reports = useUsageReports(view);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const allProjects = view.scope === "all";
  const items: { id: UsageSegment; label: string }[] = [
    { id: "model", label: "By model" },
    { id: "agent", label: allProjects ? "By project" : "By agent" },
    { id: "day", label: "By day" },
    { id: "limits", label: "Limits" },
  ];
  // B4.3: focus the dock moves here on opening draws no ring until the first key or press.
  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  return (
    <div ref={quiet} data-usage className="h-full min-h-0">
      <Panel
        name="usage"
        title="Usage"
        lead={<PanelPurpose tool="usage" />}
        views={<ViewTabs label="Usage" options={items} value={view.segment} onChange={(segment) => setView({ segment })} />}
      >
        <div className="flex h-full min-h-0 flex-col">
          {view.segment !== "limits" && (
            <PanelFilters className={cn("flex-wrap gap-y-1.5 py-1", PANEL_COLUMN)}>
              <div className="max-w-36 min-w-28 flex-1">
                <Select
                  size="sm"
                  label="Period"
                  value={view.period}
                  onChange={(period) => setView({ period: USAGE_PERIODS.find((p) => p.id === period)?.id ?? view.period })}
                  options={USAGE_PERIODS.map((p) => ({ value: p.id, label: p.label }))}
                />
              </div>
              <div className="max-w-36 min-w-28 flex-1">
                <Select
                  size="sm"
                  label="Scope"
                  value={view.scope}
                  onChange={(scope) => setView({ scope: scope === "all" ? "all" : "project" })}
                  options={[
                    { value: "project", label: "This project" },
                    { value: "all", label: "All projects" },
                  ]}
                />
              </div>
              {view.segment === "model" && !allProjects && (
                <Button variant="quiet" size="sm" pressed={view.roles} onClick={() => setView({ roles: !view.roles })}>
                  Show tiers
                </Button>
              )}
            </PanelFilters>
          )}
          <div className="min-h-0 flex-1">
            {usageEmpty(reports, view.segment) ? (
              <PanelEmpty title="No usage in this range">Tokens appear here after a request or an agent gets a model response.</PanelEmpty>
            ) : (
              <PanelBody fade>
                <div className={cn("@container/usage flex flex-col gap-3", PANEL_COLUMN)}>
                  {view.segment === "model" && <UsageByModel load={reports} view={view} />}
                  {view.segment === "agent" && <UsageByAgent load={reports} view={view} />}
                  {view.segment === "day" && <UsageByDay load={reports} view={view} now={now} />}
                  {view.segment === "limits" && <UsageLimits />}
                </div>
              </PanelBody>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
