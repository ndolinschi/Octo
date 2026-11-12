import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useNow, useScrollFade } from "../../lib/hooks";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { USAGE_PERIODS } from "../../lib/usage/model";
import { DEFAULT_USAGE_VIEW, usageRangeText, type UsageSegment, type UsageView } from "../../lib/usageView";
import { toolTab } from "../../state/workspace/layout";
import { USAGE_VIEW } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { MenuButton } from "../primitives/MenuButton";
import { UsageLimits } from "./UsageLimits";
import { UsageByAgent, UsageByDay, UsageByModel } from "./UsageViews";
import { useUsageReports } from "./useUsage";
import { ViewTabs } from "../primitives/ViewTabs";

const TAB = toolTab("usage");

/**
 * The Usage tab (decision 86): By model · By agent · By day · Limits as view tabs (decision 82), the period and scope in
 * one quiet menu on the same row. Everything comes from `getUsage` and `getLimits`; unknown cost reads "no price" and a
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
  const scroller = useRef<HTMLDivElement>(null);
  useScrollFade(scroller, "y");
  const allProjects = view.scope === "all";
  const items: { id: UsageSegment; label: string }[] = [
    { id: "model", label: "By model" },
    { id: "agent", label: allProjects ? "By project" : "By agent" },
    { id: "day", label: "By day" },
    { id: "limits", label: "Limits" },
  ];
  return (
    <div data-usage className="flex h-full min-h-0 flex-col">
      <ViewTabs
        label="Usage"
        options={items}
        value={view.segment}
        onChange={(segment) => setView({ segment })}
        trailing={
          view.segment !== "limits" && (
            <MenuButton
              label="Period and scope"
              text={usageRangeText(view)}
              alignEnd
              items={[
                ...USAGE_PERIODS.map((p) => ({ id: p.id, label: p.label, checked: view.period === p.id, run: () => setView({ period: p.id }) })),
                { id: "sep", separator: true as const },
                { id: "scope-project", label: "This project", checked: view.scope === "project", run: () => setView({ scope: "project" }) },
                { id: "scope-all", label: "All projects", checked: view.scope === "all", run: () => setView({ scope: "all" }) },
                ...(view.segment === "model" && !allProjects
                  ? [
                      { id: "sep2", separator: true as const },
                      { id: "roles", label: "Show roles", checked: view.roles, run: () => setView({ roles: !view.roles }) },
                    ]
                  : []),
              ]}
            />
          )
        }
      />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain fade-y px-pane pt-pane pb-4">
        {/* The table needs a wider measure than the label / value rows of Limits. */}
        <div className={cn("@container/usage mx-auto flex w-full flex-col gap-3", view.segment === "limits" ? "max-w-details" : "max-w-home")}>
          {view.segment === "model" && <UsageByModel load={reports} view={view} />}
          {view.segment === "agent" && <UsageByAgent load={reports} view={view} />}
          {view.segment === "day" && <UsageByDay load={reports} view={view} now={now} />}
          {view.segment === "limits" && <UsageLimits />}
        </div>
        <FloatRoom />
      </div>
    </div>
  );
}
