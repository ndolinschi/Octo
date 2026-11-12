import { useState } from "react";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { USAGE_PERIODS } from "../../lib/usage/model";
import { DEFAULT_USAGE_VIEW, type UsageSegment, type UsageView } from "../../lib/usageView";
import { toolTab } from "../../state/workspace/layout";
import { USAGE_VIEW } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { Button } from "../primitives/Button";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";
import { UsageLimits } from "./UsageLimits";
import { UsageByAgent, UsageByDay, UsageByModel } from "./UsageViews";
import { useUsageReports } from "./useUsage";
import { ViewTabs } from "../primitives/ViewTabs";

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
  return (
    <div data-usage className="flex h-full min-h-0 flex-col">
      <ViewTabs label="Usage" options={items} value={view.segment} onChange={(segment) => setView({ segment })} />
      <ScrollArea fade className="min-h-0 flex-1 px-pane pt-pane pb-4">
        {/* The table needs a wider measure than the label / value rows of Limits. */}
        <div className={cn("@container/usage mx-auto flex w-full flex-col gap-3", view.segment === "limits" ? "max-w-details" : "max-w-home")}>
          {view.segment !== "limits" && (
            <div className="flex flex-wrap items-center gap-2 px-2">
              <div className="w-36">
                <Select
                  size="sm"
                  label="Period"
                  value={view.period}
                  onChange={(period) => setView({ period: USAGE_PERIODS.find((p) => p.id === period)?.id ?? view.period })}
                  options={USAGE_PERIODS.map((p) => ({ value: p.id, label: p.label }))}
                />
              </div>
              <div className="w-36">
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
                  Show roles
                </Button>
              )}
            </div>
          )}
          {view.segment === "model" && <UsageByModel load={reports} view={view} />}
          {view.segment === "agent" && <UsageByAgent load={reports} view={view} />}
          {view.segment === "day" && <UsageByDay load={reports} view={view} now={now} />}
          {view.segment === "limits" && <UsageLimits />}
        </div>
        <FloatRoom />
      </ScrollArea>
    </div>
  );
}
