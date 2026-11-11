import { useMemo } from "react";
import { costText, formatUsd, shareRows } from "../../lib/usage";
import type { UsageView } from "../../lib/usageView";
import { InfoSection } from "../primitives/InfoList";
import { modelLabel } from "../primitives/Status";
import { ShareRows, UsageState } from "./UsageTokens";
import type { Load, UsageData } from "./useUsage";

/**
 * Cost: the total (compact USD), per model. A cost from the harness's price table is marked "estimated"; a bucket
 * without any price reads "no price" (never $0), and then one line says where prices come from.
 */
export function UsageCost({ load, view }: { load: Load<UsageData>; view: UsageView }) {
  const data = load.status === "ok" ? load.value : null;
  const total = data?.models.total;
  const rows = useMemo(
    () =>
      data
        ? shareRows(
            data.models.buckets.map((b) => ({ ...b, label: modelLabel(b.label || b.key) })),
            (b) => b.cost_usd ?? 0,
          )
        : [],
    [data],
  );
  const unpriced = data?.models.buckets.some((b) => b.cost_usd === null) ?? false;
  const empty = !data || data.models.buckets.length === 0;
  return (
    <UsageState load={load} empty={empty}>
      {total && (
        <section aria-label="Total cost" className="flex flex-col gap-1 px-2">
          <p className="flex items-baseline gap-2 text-figure text-fg tabular-nums">
            {total.cost_usd === null ? <span className="text-fg-3">No price</span> : formatUsd(total.cost_usd)}
            {total.cost_estimated && <span className="text-xs font-normal text-fg-3">estimated</span>}
          </p>
          <p className="text-xs text-fg-3">
            Last {view.days} days, {view.scope === "project" ? "this project" : "all projects"}
            {unpriced && total.cost_usd !== null ? ". Models without a price are not included." : ""}
          </p>
        </section>
      )}
      <InfoSection title="By model" labelId="usage-cost-models">
        <ShareRows
          rows={rows}
          value={(r) => (
            <>
              <span className={r.bucket.cost_usd === null ? "text-fg-3" : undefined}>{costText(r.bucket)}</span>
              {r.bucket.cost_estimated && <span className="ml-1 text-fg-3">est.</span>}
            </>
          )}
          title={(r) =>
            r.bucket.cost_usd === null
              ? `${r.key}: no price for this model`
              : `${r.key}: $${r.bucket.cost_usd.toFixed(4)}${r.bucket.cost_estimated ? " (estimated from the price table)" : " (reported by the source)"}`
          }
        />
      </InfoSection>
      {unpriced && (
        <p className="px-2 text-xs text-fg-3">
          Prices come from <code className="font-mono">prices.toml</code> in the harness data directory (USD per million tokens). A model missing from it has no
          price; costs an external agent reports are shown as reported.
        </p>
      )}
    </UsageState>
  );
}
