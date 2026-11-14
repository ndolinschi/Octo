import assert from "node:assert/strict";
import test from "node:test";
import { storedEndingLookup, storedEndingOf, storedEndings } from "./storedEndings";
import { RESTART_INTERRUPTION } from "./transcript";

test("B4: a stored exchange gives a request's ending and duration, only for the prompt it started with", () => {
  const endings = storedEndings([
    { turn_id: 7, status: "stopped", started_at: "2026-11-10T10:00:00.000Z", duration_ms: 5_200 },
    { turn_id: 9, status: "completed", started_at: "2026-11-10T10:10:00.000Z", duration_ms: 3_000, removed: true },
  ]);
  const prompt = { id: 7, created_at: "2026-11-10T10:00:00.400Z" };
  assert.deepEqual(storedEndingOf(endings, prompt), { status: "cancelled", startedAt: Date.parse("2026-11-10T10:00:00.000Z"), ms: 5_200 });
  // Another session's message with the same id (sent at another time) is not this exchange's request.
  assert.equal(storedEndingOf(endings, { id: 7, created_at: "2026-11-10T11:00:00Z" }), undefined);
  assert.equal(storedEndingOf(endings, { id: 9, created_at: "2026-11-10T10:10:00Z" }), undefined);
  assert.equal(storedEndingOf(endings, null), undefined);
});

test("B4: the lookup the transcript keeps answers like storedEndingOf", () => {
  const of = storedEndingLookup([{ turn_id: 3, status: "failed", started_at: "2026-11-10T10:00:00.000Z", duration_ms: -5 }]);
  assert.deepEqual(of({ id: 3, created_at: "2026-11-10T10:00:01Z" }), { status: "failed", startedAt: Date.parse("2026-11-10T10:00:00.000Z"), ms: 0 });
  assert.equal(of(null), undefined);
});

test("P1-1: an exchange the harness closed after a restart is a failed ending marked interrupted, with its sentence", () => {
  const of = storedEndingLookup([
    { turn_id: 4, status: "failed", started_at: "2026-11-10T10:00:00.000Z", duration_ms: 12_000, interrupted: true },
    { turn_id: 5, status: "failed", started_at: "2026-11-10T10:01:00.000Z", duration_ms: 3_000 },
  ]);
  assert.deepEqual(of({ id: 4, created_at: "2026-11-10T10:00:00Z" }), {
    status: "failed",
    startedAt: Date.parse("2026-11-10T10:00:00.000Z"),
    ms: 12_000,
    interrupted: true,
    error: RESTART_INTERRUPTION,
  });
  assert.deepEqual(of({ id: 5, created_at: "2026-11-10T10:01:00Z" }), { status: "failed", startedAt: Date.parse("2026-11-10T10:01:00.000Z"), ms: 3_000 });
});
