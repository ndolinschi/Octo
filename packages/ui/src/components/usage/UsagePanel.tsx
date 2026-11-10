import { useRef, useState } from "react";
import { useNow, useScrollFade } from "../../lib/hooks";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { DEFAULT_USAGE_VIEW, USAGE_DAYS, type UsageView } from "../../lib/usageView";
import { toolTab } from "../../state/workspace/layout";
import { USAGE_VIEW } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { Segmented } from "../primitives/Segmented";
import { UsageCost } from "./UsageCost";
import { UsageLimits } from "./UsageLimits";
import { UsageTokens } from "./UsageTokens";
import { useUsageReports } from "./useUsage";

const TAB = toolTab("usage");

/**
 * The Usage tab (v6.2, Part C): Tokens | Cost | Limits over the last 7 / 30 / 90 days, for this project or all
 * projects. Everything comes from `getUsage` and `getLimits`; unknown cost reads "no price", estimates are marked,
 * and nothing is shown for plan limits the harness cannot read. The controls are remembered per tab.
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
      <div className="mx-auto flex w-full max-w-details flex-col gap-3">
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
          <div className="flex items-center gap-2">
            <Segmented
              label="Range"
              size={24}
              options={USAGE_DAYS.map((d) => ({ id: d, label: `${d}d`, title: `Last ${d} days` }))}
              value={view.days}
              onChange={(days) => setView({ days })}
              className="w-32"
            />
            <Segmented
              label="Scope"
              size={24}
              options={[
                { id: "project", label: "This project" },
                { id: "all", label: "All projects" },
              ]}
              value={view.scope}
              onChange={(scope) => setView({ scope })}
              className="ml-auto min-w-0 flex-1"
            />
          </div>
        )}
        {view.segment === "tokens" && <UsageTokens load={reports} view={view} now={now} />}
        {view.segment === "cost" && <UsageCost load={reports} view={view} />}
        {view.segment === "limits" && <UsageLimits />}
      </div>
      <FloatRoom />
    </div>
  );
}
