import { useRef, useState } from "react";
import { useNow, useScrollFade } from "../../lib/hooks";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { DEFAULT_USAGE_VIEW, USAGE_DAYS, usageRangeText, type UsageView } from "../../lib/usageView";
import { toolTab } from "../../state/workspace/layout";
import { USAGE_VIEW } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { MenuButton } from "../primitives/MenuButton";
import { Segmented } from "../primitives/Segmented";
import { UsageCost } from "./UsageCost";
import { UsageLimits } from "./UsageLimits";
import { UsageTokens } from "./UsageTokens";
import { useUsageReports } from "./useUsage";

const TAB = toolTab("usage");

/**
 * The Usage tab (v6.2, Part C): Tokens | Cost | Limits over the last 7 / 30 / 90 days, for this project or all
 * projects. Everything comes from `getUsage` and `getLimits`; unknown cost reads "no price", estimates are marked,
 * and nothing is shown for plan limits the harness cannot read. The controls are remembered per tab; range and scope share
 * one quiet menu (decision 33).
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
  return (
    <div ref={scroller} data-usage className="h-full min-h-0 overflow-y-auto overscroll-contain fade-y px-pane pt-pane pb-4">
      <div className="@container/usage mx-auto flex w-full max-w-details flex-col gap-3">
        {/* Decision 33: one segmented control (the view), and one quiet menu for range + scope on the same row. */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <Segmented
            label="Usage"
            options={[
              { id: "tokens", label: "Tokens" },
              { id: "cost", label: "Cost" },
              { id: "limits", label: "Limits" },
            ]}
            value={view.segment}
            onChange={(segment) => setView({ segment })}
          />
          {view.segment !== "limits" && (
            <MenuButton
              label="Range and scope"
              text={usageRangeText(view)}
              alignEnd
              items={[
                ...USAGE_DAYS.map((d) => ({ id: `d${d}`, label: `Last ${d} days`, checked: view.days === d, run: () => setView({ days: d }) })),
                { id: "sep", separator: true as const },
                { id: "project", label: "This project", checked: view.scope === "project", run: () => setView({ scope: "project" }) },
                { id: "all", label: "All projects", checked: view.scope === "all", run: () => setView({ scope: "all" }) },
              ]}
            />
          )}
        </div>
        {view.segment === "tokens" && <UsageTokens load={reports} view={view} now={now} />}
        {view.segment === "cost" && <UsageCost load={reports} view={view} />}
        {view.segment === "limits" && <UsageLimits />}
      </div>
      <FloatRoom />
    </div>
  );
}
