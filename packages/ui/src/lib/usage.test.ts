import assert from "node:assert/strict";
import test from "node:test";
import type { Limit, UsageBucket, UsageReport } from "@octo/agent-client";
import {
  isFlatRate,
  paidCost,
  subscriptionTotal,
  barHeights,
  costText,
  daysWithData,
  fillDays,
  formatCountdown,
  rangeOf,
  formatUsd,
  isStale,
  mergeBy,
  observedLabel,
  remainingShare,
  remainingText,
  spentShare,
  resetLabel,
  shareRows,
  sortLimits,
} from "./usage";
import { contextText } from "./usageView";

const NOW = Date.parse("2026-11-10T15:00:00Z");
const bucket = (key: string, n: number, p: Partial<UsageBucket> = {}): UsageBucket => ({
  key,
  label: key,
  input_tokens: n,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  requests: 1,
  cost_usd: null,
  cost_estimated: false,
  ...p,
});
const report = (buckets: UsageBucket[]): UsageReport => ({ from: "", to: "", group: "day", buckets, total: bucket("total", 0) });

test("fillDays: UTC days ending today, oldest first, zero days filled", () => {
  const days = fillDays(report([bucket("2026-11-10", 5, { cache_read_tokens: 2 }), bucket("2026-11-08", 3)]), 3, NOW);
  assert.deepEqual(
    days.map((d) => [d.key, d.total]),
    [
      ["2026-11-08", 3],
      ["2026-11-09", 0],
      ["2026-11-10", 7],
    ],
  );
  assert.equal(daysWithData(days), 2);
  assert.equal(fillDays(null, 7, NOW).length, 7);
});

test("barHeights: integer heights, a floor for small days, linear when even", () => {
  const { scale, heights } = barHeights([10, 0, 5, 8], 32);
  assert.equal(scale, "linear");
  assert.deepEqual(heights, [32, 0, 16, 26]);
  assert.ok(heights.every(Number.isInteger));
  assert.deepEqual(barHeights([0, 0], 32).heights, [0, 0]);
  assert.equal(barHeights([1, 900, 1000, 950], 32).heights[0], 2, "min height for a tiny day");
});

test("barHeights: logarithmic when even a square root would flatten the rest", () => {
  const { scale, heights } = barHeights([1000, 2000, 1500, 5_000_000], 32);
  assert.equal(scale, "log");
  assert.equal(heights[3], 32);
  assert.ok((heights[0] ?? 0) >= 6 && (heights[1] ?? 0) > (heights[0] ?? 0), String(heights));
});

test("barHeights: square root when one day dominates, so the rest stay visible", () => {
  const values = [1000, 1600, 900, 1100, 100_000];
  const { scale, heights } = barHeights(values, 32);
  assert.equal(scale, "sqrt");
  assert.equal(heights[4], 32);
  assert.ok((heights[1] ?? 0) > (heights[2] ?? 0), String(heights));
  assert.ok((heights[2] ?? 0) > 2, "a linear scale would floor these at 2px");
});

test("money: compact USD, unknown cost is 'no price', never $0", () => {
  assert.equal(formatUsd(0.001), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.42), "$0.42");
  assert.equal(formatUsd(123.4), "$123");
  assert.equal(formatUsd(1234), "$1.2k");
  assert.equal(costText({ cost_usd: null }), "no price");
  assert.equal(costText({ cost_usd: 1.5 }), "$1.50");
});

test("shareRows: largest first, share of the largest", () => {
  const rows = shareRows([bucket("a", 10), bucket("b", 40), bucket("c", 20)]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.share]),
    [
      ["b", 1],
      ["c", 0.5],
      ["a", 0.25],
    ],
  );
});

test("mergeBy sums buckets under one label; cost null only when every part is", () => {
  const merged = mergeBy(
    [bucket("x", 1, { label: "Scout" }), bucket("y", 2, { label: "Scout", cost_usd: 0.5, cost_estimated: true }), bucket("z", 4, { label: "Runner" })],
    (b) => b.label,
  );
  const scout = merged.find((b) => b.key === "Scout");
  assert.equal(scout?.input_tokens, 3);
  assert.equal(scout?.requests, 2);
  assert.equal(scout?.cost_usd, 0.5);
  assert.equal(scout?.cost_estimated, true);
  assert.equal(merged.find((b) => b.key === "Runner")?.cost_usd, null);
});

test("limits: countdown stops at zero, stale after ten minutes", () => {
  assert.equal(formatCountdown(42_400), "42s");
  assert.equal(formatCountdown(-5000), "0s");
  assert.equal(formatCountdown(190_000), "3m 10s");
  assert.equal(resetLabel(new Date(NOW + 42_000).toISOString(), NOW), "resets in 42s");
  assert.equal(resetLabel(new Date(NOW - 42_000).toISOString(), NOW), "resets in 0s");
  assert.equal(resetLabel(null, NOW), null);
  assert.equal(isStale(new Date(NOW - 11 * 60_000).toISOString(), NOW), true);
  assert.equal(isStale(new Date(NOW - 9 * 60_000).toISOString(), NOW), false);
  assert.equal(observedLabel(new Date(NOW - 120_000).toISOString(), NOW), "observed 2m ago");
});

test("limits: remaining share and text, sorted by provider, model, kind", () => {
  const l = (kind: Limit["kind"], model = "m", p: Partial<Limit> = {}): Limit => ({
    provider: "api.example.com",
    model,
    kind,
    limit: 40_000,
    remaining: 38_000,
    resets_at: null,
    observed_at: "",
    ...p,
  });
  assert.equal(remainingShare(l("tokens")), 0.95);
  assert.equal(remainingShare(l("tokens", "m", { limit: null })), null);
  // B43: what is left, in words (was "38k / 40k", read as spent).
  assert.equal(remainingText(l("tokens")), "38k of 40k left");
  assert.equal(remainingText(l("requests", "m", { limit: 4000, remaining: 3998 })), "3,998 of 4,000 left");
  assert.equal(remainingText(l("requests", "m", { limit: 2_000_000, remaining: 1_712_400 })), "1.7M of 2M left");
  assert.ok(Math.abs((spentShare(l("tokens")) ?? 0) - 0.05) < 1e-9);
  assert.deepEqual(
    sortLimits([l("output_tokens"), l("requests", "b"), l("requests")]).map((x) => `${x.model}:${x.kind}`),
    ["b:requests", "m:requests", "m:output_tokens"],
  );
});

test("context: shown only when both figures are reported", () => {
  assert.equal(contextText(1800, 200_000), "context 1.8k / 200k");
  assert.equal(contextText(null, 200_000), null);
  assert.equal(contextText(1800, undefined), null);
  assert.equal(contextText(1800, 0), null);
});

test("range: the last N UTC days, to exclusive", () => {
  assert.deepEqual(rangeOf(7, NOW), { from: "2026-11-04", to: "2026-11-11" });
  assert.deepEqual(rangeOf(1, NOW), { from: "2026-11-10", to: "2026-11-11" });
});

test("flat-rate rows: shown as an equivalent, never added to the paid total", () => {
  const paid = { cost_usd: 1.2 };
  const flat = { cost_usd: 0.53, flat_rate: true };
  assert.equal(costText(flat), "≈ $0.53 on your subscription");
  assert.equal(costText(paid), formatUsd(1.2));
  assert.equal(isFlatRate(flat), true);
  assert.equal(isFlatRate(paid), false);
  assert.equal(paidCost({ cost_usd: 1.73 }, [paid, flat]), 1.2);
  assert.equal(paidCost({ cost_usd: null }, [flat]), null);
});

test("the real harness shape: cost_usd null + subscription_equivalent_usd, no flat_rate", () => {
  const sub = { cost_usd: null, subscription_equivalent_usd: 1.08 };
  const flatNew = { cost_usd: 0, flat_rate: true, subscription_equivalent_usd: 0.53 };
  const paid = { cost_usd: 2, flat_rate: false, subscription_equivalent_usd: 0 };
  assert.equal(isFlatRate(sub), true);
  assert.equal(costText(sub), "≈ $1.08 on your subscription");
  assert.equal(costText(flatNew), "≈ $0.53 on your subscription");
  assert.equal(costText(paid), formatUsd(2));
  assert.equal(isFlatRate(paid), false);
  assert.equal(paidCost({ cost_usd: 2 }, [sub, flatNew, paid]), 2);
  assert.ok(Math.abs(subscriptionTotal([sub, flatNew, paid]) - 1.61) < 1e-9);
});
