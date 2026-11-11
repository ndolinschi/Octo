import { must } from "../../lib/must";
import type { Agent, ProjectSummary } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { WEEKS, dayStart, heatCounts, monthStart } from "./useOverview";

// Day arithmetic is local-time; pin the zone so cell boundaries are the same everywhere.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "UTC";

const DAY = 86_400_000;
const now = Date.parse("2026-11-10T12:00:00Z"); // a Tuesday
const run = (startedAt: string | null, over: Partial<Agent> = {}) =>
  ({ id: "r", parent_id: "root", created_at: startedAt ?? "2026-11-10T00:00:00Z", started_at: startedAt, ...over }) as Agent;
const project = { id: "p" } as ProjectSummary;
const heat = (agents: Agent[], requests: number[] = []) => heatCounts([{ project, agents }], requests, now);

test("day and month starts are local midnight and the first of the month", () => {
  assert.equal(dayStart(now), Date.parse("2026-11-10T00:00:00Z"));
  assert.equal(monthStart(now), Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(monthStart(now, -1), Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(monthStart(Date.parse("2026-01-15T00:00:00Z"), -1), Date.parse("2025-12-01T00:00:00Z"), "across a year");
  assert.equal(monthStart(Date.parse("2026-12-15T00:00:00Z"), 1), Date.parse("2027-01-01T00:00:00Z"));
});

test("the grid is 26 whole weeks of days, from a Monday, ending with the current week", () => {
  const { days } = heat([]);
  assert.equal(days.length, WEEKS * 7);
  assert.equal(new Date(must(days[0]).at).getUTCDay(), 1);
  assert.equal(new Date(must(days[days.length - 1]).at).getUTCDay(), 0);
  assert.ok(days.some((d) => d.at === dayStart(now)));
  assert.ok(days.every((d, i) => i === 0 || d.at - must(days[i - 1]).at === DAY));
});

test("runs are counted on the day they started; orchestrators are not runs", () => {
  const out = heat([run("2026-11-10T01:00:00Z"), run("2026-11-10T23:00:00Z"), run("2026-11-09T10:00:00Z"), run("2026-11-10T02:00:00Z", { parent_id: null })]);
  const cell = (iso: string) => must(out.days.find((d) => d.at === Date.parse(iso)));
  assert.equal(cell("2026-11-10T00:00:00Z").count, 1, "11pm today is after now (12:00), so only the 1am run counts");
  assert.equal(cell("2026-11-09T00:00:00Z").count, 1);
  assert.equal(out.runs, 2);
});

test("runs before the grid, after now, or never started (falling back to creation) are handled", () => {
  const first = must(heat([]).days[0]).at;
  const before = new Date(first - 1000).toISOString();
  assert.equal(heat([run(before)]).runs, 0);
  assert.equal(heat([run("2026-11-11T09:00:00Z")]).runs, 0, "a start in the future is ignored");
  assert.equal(must(heat([run(new Date(first).toISOString())]).days[0]).count, 1, "the first instant of the grid is inside");
  assert.equal(heat([run(null, { created_at: "2026-11-08T10:00:00Z" })]).runs, 1);
});

test("requests are counted over the same span, across projects", () => {
  const first = must(heat([]).days[0]).at;
  assert.equal(heat([], [now - 1000, now, first, first - 1, now + 1]).requests, 3);
  const two = heatCounts(
    [
      { project, agents: [run("2026-11-10T01:00:00Z")] },
      { project, agents: [run("2026-11-10T02:00:00Z")] },
    ],
    [],
    now,
  );
  assert.equal(two.runs, 2);
});

test("a day's cell counts its runs and its requests (a project with requests but no runs is not an empty map)", () => {
  const out = heat([run("2026-11-09T10:00:00Z")], [Date.parse("2026-11-09T11:00:00Z"), Date.parse("2026-11-08T11:00:00Z")]);
  const cell = (iso: string) => must(out.days.find((d) => d.at === Date.parse(iso)));
  assert.deepEqual([cell("2026-11-09T00:00:00Z").count, cell("2026-11-09T00:00:00Z").runs, cell("2026-11-09T00:00:00Z").requests], [2, 1, 1]);
  assert.equal(cell("2026-11-08T00:00:00Z").count, 1);
});
