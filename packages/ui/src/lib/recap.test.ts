import assert from "node:assert/strict";
import test from "node:test";
import { buildRecap, recapText, runWithin } from "./recap";

const atlas = { id: "a", name: "Atlas API", requests: 7 };
const docs = { id: "d", name: "Docs site", requests: 4 };

test("the full sentence", () => {
  const parts = buildRecap({
    period: "today",
    projects: [docs, atlas, { id: "o", name: "Orbit", requests: 1 }],
    topModel: { key: "claude-sonnet-5-5", name: "Sonnet 5.5", share: 0.842 },
    agentMs: (5 * 60 + 47) * 60_000,
  });
  assert.equal(
    recapText(parts ?? []),
    "Today you sent 12 requests across 3 projects. Most went into Atlas API; Sonnet 5.5 carried 84% of the tokens. Agents ran for 5h 47m.",
  );
  assert.deepEqual(
    parts?.filter((p) => "link" in p).map((p) => ("link" in p ? p.link : null)),
    [{ project: "a" }, { model: "claude-sonnet-5-5" }, { usage: true }],
  );
});

test("singular and one project", () => {
  const parts = buildRecap({ period: "week", projects: [{ ...atlas, requests: 1 }], topModel: null, agentMs: 0 });
  assert.equal(recapText(parts ?? []), "This week you sent 1 request to Atlas API.");
});

test("clauses with no data are omitted", () => {
  assert.equal(buildRecap({ period: "today", projects: [], topModel: null, agentMs: 0 }), null);
  assert.equal(recapText(buildRecap({ period: "today", projects: [], topModel: null, agentMs: 90_000 }) ?? []), "Today agents ran for 1m 30s.");
  assert.equal(
    recapText(buildRecap({ period: "today", projects: [], topModel: { key: "m", name: "Opus 5.5", share: 0.5 }, agentMs: 0 }) ?? []),
    "Today, Opus 5.5 carried 50% of the tokens.",
  );
  assert.equal(
    recapText(buildRecap({ period: "today", projects: [{ ...atlas, requests: 2 }], topModel: { key: "m", name: "Opus 5.5", share: 1 }, agentMs: 0 }) ?? []),
    "Today you sent 2 requests to Atlas API. Opus 5.5 carried 100% of the tokens.",
  );
});

test("runWithin clips to the period", () => {
  assert.equal(runWithin(0, 100, 50), 50);
  assert.equal(runWithin(60, 100, 50), 40);
  assert.equal(runWithin(0, 40, 50), 0);
});
