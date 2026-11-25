import assert from "node:assert/strict";
import test from "node:test";
import type { UsageBucket } from "@octo/agent-client";
import { chartDays, costCellText, periodRange, placeRoles, rowCost, usageCsv, usageRows, usageTotals } from "./model";

const b = (key: string, p: Partial<UsageBucket> = {}): UsageBucket => ({
  key,
  label: key,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  requests: 1,
  cost_usd: null,
  cost_estimated: false,
  ...p,
});
const NOW = Date.parse("2026-11-10T15:00:00Z");

const api = b("claude-opus", {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 4000,
  cache_write_tokens: 500,
  requests: 3,
  cost_usd: 1.2,
  cost_estimated: true,
});
const flat = b("acp:claude", { input_tokens: 5000, output_tokens: 800, cost_usd: 0, flat_rate: true, subscription_equivalent_usd: 0.5 });
const unpriced = b("haiku", { input_tokens: 10, output_tokens: 5 });

test("rows are sorted by total, ties by label, and carry a share of the table", () => {
  const rows = usageRows([unpriced, api, flat]);
  assert.deepEqual(
    rows.map((r) => r.key),
    ["claude-opus", "acp:claude", "haiku"],
  );
  assert.equal(rows[0]?.cached, 4500);
  assert.equal(rows[0]?.total, 6000);
  assert.ok(Math.abs(rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9);
  assert.deepEqual(
    usageRows([b("2026-11-08"), b("2026-11-10"), b("2026-11-09")], undefined, "key-desc").map((r) => r.key),
    ["2026-11-10", "2026-11-09", "2026-11-08"],
  );
});

test("totals equal the sum of the rows; spend skips flat rows and unpriced ones", () => {
  const rows = usageRows([api, flat, unpriced]);
  const t = usageTotals(rows);
  assert.equal(
    t.total,
    rows.reduce((n, r) => n + r.total, 0),
  );
  assert.equal(t.input, 6010);
  assert.equal(t.requests, 5);
  assert.equal(t.cost.spent, 1.2);
  assert.equal(t.cost.equivalent, 0.5);
  assert.equal(t.unpriced, true);
  assert.equal(usageTotals(usageRows([unpriced])).cost.spent, null);
  assert.equal(usageTotals([]).total, 0);
});

test("cost text: spend, subscription, mixed, no price", () => {
  assert.equal(costCellText(rowCost(api)), "$1.20");
  assert.equal(costCellText(rowCost(flat)), "≈ $0.50 on your subscription");
  assert.equal(costCellText(rowCost(unpriced)), "no price");
  assert.equal(costCellText(rowCost(b("m", { cost_usd: 2, subscription_equivalent_usd: 0.25 }))), "$2.00 + ≈ $0.25 subscription");
  // An older harness: the equivalent sat in cost_usd of a flat-rate row.
  const old = rowCost(b("acp:x", { cost_usd: 0.4, flat_rate: true }));
  assert.equal(old.spent, 0);
  assert.equal(old.equivalent, 0.4);
});

test("periods: range for the harness and chart length", () => {
  assert.deepEqual(periodRange("today", NOW, 0), { from: "2026-11-10", to: "2026-11-11" });
  assert.deepEqual(periodRange("7d", NOW, 0), { from: "2026-11-04", to: "2026-11-11" });
  assert.deepEqual(periodRange("all", NOW, 0), { from: "2000-01-01" });
  assert.deepEqual(periodRange("session", NOW, NOW - 1000), { from: "2026-11-10T14:59:59.000Z" });
  assert.equal(chartDays("7d", null, NOW), 7);
  assert.equal(chartDays("all", "2026-11-01", NOW), 10);
  assert.equal(chartDays("all", "2025-01-01", NOW), 90);
  assert.equal(chartDays("all", null, NOW), 7);
  assert.equal(chartDays("today", null, NOW), 1);
});

test("roles go under the model that ran them; unknown ones are returned apart", () => {
  const models = usageRows([api, flat]);
  const agents = [
    b("a1", { label: "orchestrator", input_tokens: 600 }),
    b("a2", { label: "reviewer", input_tokens: 300 }),
    b("a3", { label: "reviewer", input_tokens: 100 }),
    b("a4", { label: "summary", input_tokens: 7 }),
  ];
  const which: Record<string, string> = { a1: "claude-opus", a2: "claude-opus", a3: "claude-opus" };
  const { rows, unplaced } = placeRoles(
    models,
    agents,
    (k) => which[k] ?? null,
    (x) => x.label,
  );
  const opus = rows.find((r) => r.key === "claude-opus");
  assert.deepEqual(
    opus?.roles.map((r) => [r.label, r.total]),
    [
      ["orchestrator", 600],
      ["reviewer", 400],
    ],
  );
  assert.deepEqual(
    unplaced.map((r) => r.label),
    ["summary"],
  );
  assert.equal(rows.find((r) => r.key === "acp:claude")?.roles.length, 0);
  // B44: a role's share is of the whole table, as a model's is.
  const table = models.reduce((n, m) => n + m.total, 0);
  for (const r of opus?.roles ?? []) assert.ok(Math.abs(r.share - r.total / table) < 1e-9);
});

test("csv: header, exact numbers, quoting, total", () => {
  const rows = usageRows([api, flat]);
  const first = rows[0];
  assert.ok(first);
  const csv = usageCsv("Model", [...rows.map((row) => ({ row })), { row: { ...first, label: 'say "hi", ok' }, parent: "p" }], usageTotals(rows));
  const lines = csv.split("\n");
  assert.equal(lines[0], "Model,Input,Cached,Output,Total tokens,Requests,Cost (USD),On subscription (USD)");
  assert.equal(lines[1], "claude-opus,1000,4500,500,6000,3,1.2000,");
  assert.equal(lines[2], "acp:claude,5000,0,800,5800,1,0.0000,0.5000");
  assert.ok(lines[3]?.startsWith('"p / say ""hi"", ok",'));
  assert.equal(lines[4], "Total,6000,4500,1300,11800,4,1.2000,0.5000");
});
