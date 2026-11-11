import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { UsageBucket, UsageReport } from "./types";

// The fixtures are the harness's real /v1/usage answers (written by its contract test).
const here = decodeURIComponent((import.meta as unknown as { url: string }).url.replace(/^file:\/\//, "").replace(/[^/]*$/, ""));
const load = (name: string) => JSON.parse(readFileSync(`${here}fixtures/usage.${name}.json`, "utf8")) as UsageReport;

const complete = (b: UsageBucket) => {
  assert.equal(typeof b.flat_rate, "boolean");
  assert.notEqual(b.subscription_equivalent_usd, undefined);
  assert.equal(typeof b.cost_usd, "number");
};

test("an API model's usage is spend and not flat-rate", () => {
  const r = load("api");
  for (const b of [...r.buckets, r.total]) complete(b);
  assert.equal(r.total.flat_rate, false);
  assert.equal(r.total.cost_usd, 0.0123);
  assert.equal(r.total.subscription_equivalent_usd, null);
});

test("a flat-rate agent costs 0 and carries its subscription equivalent", () => {
  const r = load("flat");
  for (const b of [...r.buckets, r.total]) complete(b);
  assert.equal(r.total.flat_rate, true);
  assert.equal(r.total.cost_usd, 0);
  assert.equal(r.total.subscription_equivalent_usd, 0.5);
});

test("mixed usage is not flat-rate overall and keeps both figures", () => {
  const r = load("mixed");
  for (const b of [...r.buckets, r.total]) complete(b);
  assert.equal(r.total.flat_rate, false);
  assert.equal(r.total.cost_usd, 0.0123);
  assert.equal(r.total.subscription_equivalent_usd, 0.5);
  assert.deepEqual(r.buckets.map((b) => [b.key, b.flat_rate]).sort(), [
    ["acp:grok", true],
    ["claude-sonnet-5-5", false],
  ]);
});
