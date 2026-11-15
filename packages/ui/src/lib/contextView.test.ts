import assert from "node:assert/strict";
import test from "node:test";
import type { ContextOverview } from "@octo/agent-client";
import { cacheLine, contextHeadline, contextView, lastTurnView, percentShares } from "./contextView";

const harness: ContextOverview = {
  window: 200_000,
  used: 82_000,
  reserved: 8_000,
  source: "harness",
  compacted_turns_ago: 2,
  categories: [
    { id: "tools", label: "Tool definitions", tokens: 9_300 },
    { id: "tool_results", label: "Tool results", tokens: 29_800 },
    { id: "messages", label: "Conversation", tokens: 21_400 },
    { id: "empty", label: "Nothing", tokens: 0 },
  ],
  last_request: { input: 64_000, cached: 49_600, output: 3_100 },
};

test("percentShares add up to exactly 100", () => {
  for (const v of [
    [1, 1, 1],
    [33, 33, 34],
    [5, 3, 2],
    [1, 0, 0],
    [7, 11, 13, 17, 19],
  ])
    assert.equal(
      percentShares(v).reduce((n, x) => n + x, 0),
      100,
    );
  assert.deepEqual(percentShares([0, 0]), [0, 0]);
});

test("contextView: categories largest first, then reserved and free; shares sum to 100; zero categories dropped", () => {
  const v = contextView(harness);
  assert.deepEqual(
    v.rows.map((r) => r.id),
    ["tool_results", "messages", "tools", "reserved", "free"],
  );
  assert.equal(
    v.rows.reduce((n, r) => n + r.percent, 0),
    100,
  );
  assert.equal(v.free, 200_000 - 82_000 - 8_000);
  assert.equal(v.usedPercent, 41);
  assert.equal(v.compacted, "history was compacted 2 requests ago");
});

test("the ≈ rule: estimates by the harness are marked, what an agent reports is not", () => {
  assert.equal(contextHeadline(contextView(harness)), "≈41% of 200k used · ≈110k free");
  assert.equal(contextHeadline(contextView({ ...harness, estimated: false })), "41% of 200k used · 110k free");
  const agent = contextView({ window: 200_000, used: 61_000, source: "agent", categories: [] });
  assert.equal(agent.source, "agent");
  assert.deepEqual(agent.rows, []);
  assert.equal(contextHeadline(agent), "61k of 200k used (reported by the agent)");
  assert.equal(agent.approx, false);
});

test("the older breakdown is read too; without the endpoint the last turn gives a headline only", () => {
  const old = contextView({
    agent_id: "a",
    model: "m",
    window_tokens: 1000,
    used_tokens: 500,
    estimated: true,
    parts: [
      { key: "messages", tokens: 300 },
      { key: "system", tokens: 200 },
    ],
  });
  assert.deepEqual(
    old.rows.map((r) => r.label),
    ["Messages", "Instructions", "Free"],
  );
  assert.equal(
    old.rows.reduce((n, r) => n + r.percent, 0),
    100,
  );
  const last = lastTurnView(61_000, 200_000);
  assert.ok(last.fromLastTurn && last.rows.length === 0);
  assert.equal(contextHeadline(last), "≈31% of 200k used · ≈139k free");
});

test("cacheLine: cached share of the last request's input", () => {
  assert.equal(cacheLine(contextView(harness)), "Last request: 64k read (78% from cache), 3.1k written");
  assert.equal(cacheLine(contextView({ window: 200_000, used: 1, source: "harness", categories: [] })), null);
});
