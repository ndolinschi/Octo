import assert from "node:assert/strict";
import test from "node:test";
import { storedEndingLookup, storedEndingOf, storedEndings } from "./storedEndings";
import { RESTART_EMPTY_HINT, RESTART_INTERRUPTION, RESTART_KEPT_HINT } from "./turnEnding";

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
    fields: { action: "retry" },
  });
  assert.deepEqual(of({ id: 5, created_at: "2026-11-10T10:01:00Z" }), { status: "failed", startedAt: Date.parse("2026-11-10T10:01:00.000Z"), ms: 3_000 });
});

test("NEW-1: every stored failure carries the harness's error like a live one: message, hint, and the action of its code", () => {
  const at = (m: number) => `2026-11-10T10:0${m}:00.000Z`;
  const of = storedEndingLookup([
    {
      turn_id: 1,
      status: "failed",
      started_at: at(1),
      duration_ms: 900,
      error: {
        code: "model_unreachable",
        message: "The connection to the model broke off.",
        hint: "Check the network and the provider in Settings, then try again.",
      },
      kept_text: false,
    },
    {
      turn_id: 2,
      status: "failed",
      started_at: at(2),
      duration_ms: 900,
      error: { code: "agent_not_logged_in", message: "Copilot is not logged in.", hint: "Run `copilot login` in a terminal." },
    },
    { turn_id: 3, status: "failed", started_at: at(3), duration_ms: 900, error: { code: "budget_reached", message: "This project's budget is used up." } },
    { turn_id: 4, status: "stopped", started_at: at(4), duration_ms: 900, kept_text: true },
  ]);
  const one = of({ id: 1, created_at: at(1) });
  assert.equal(one?.error, "The connection to the model broke off.");
  assert.deepEqual(one?.fields, { hint: "Check the network and the provider in Settings, then try again.", action: "retry" });
  assert.equal(one?.code, "model_unreachable");
  assert.equal(one?.keptText, false);
  assert.deepEqual(of({ id: 2, created_at: at(2) })?.fields, { hint: "Run `copilot login` in a terminal.", action: "recheck_provider" });
  assert.deepEqual(of({ id: 3, created_at: at(3) })?.fields, { action: "open_settings" });
  // A stopped turn has no failure; it keeps whether its text stayed.
  const four = of({ id: 4, created_at: at(4) });
  assert.equal(four?.error, undefined);
  assert.equal(four?.keptText, true);
});

test("NEW-9: an interrupted exchange keeps the harness's hint as given; without a stored error the hint follows kept_text", () => {
  const at = "2026-11-10T10:00:00.000Z";
  const stored = storedEndings([
    {
      turn_id: 1,
      status: "failed",
      started_at: at,
      duration_ms: 1,
      interrupted: true,
      kept_text: false,
      error: { code: "turn_interrupted", message: RESTART_INTERRUPTION, hint: RESTART_EMPTY_HINT },
    },
    { turn_id: 2, status: "failed", started_at: at, duration_ms: 1, interrupted: true, kept_text: true },
    { turn_id: 3, status: "failed", started_at: at, duration_ms: 1, interrupted: true, kept_text: false },
    { turn_id: 4, status: "failed", started_at: at, duration_ms: 1, interrupted: true },
  ]);
  assert.deepEqual(stored.get(1)?.fields, { hint: RESTART_EMPTY_HINT, action: "retry" });
  assert.equal(stored.get(1)?.interrupted, true);
  assert.deepEqual(stored.get(2)?.fields, { action: "retry", hint: RESTART_KEPT_HINT });
  assert.deepEqual(stored.get(3)?.fields, { action: "retry", hint: RESTART_EMPTY_HINT });
  assert.deepEqual(stored.get(4)?.fields, { action: "retry" });
});

test("NEW-1: a lookup over several sessions finds each prompt's exchange in the session it started in", () => {
  const of = storedEndingLookup(
    [{ turn_id: 5, status: "completed", started_at: "2026-11-10T12:00:00.000Z", duration_ms: 1_000 }],
    [
      {
        turn_id: 5,
        status: "failed",
        started_at: "2026-11-10T09:00:00.000Z",
        duration_ms: 2_000,
        error: { code: "internal", message: "Something went wrong inside Octo." },
      },
    ],
  );
  assert.equal(of({ id: 5, created_at: "2026-11-10T12:00:00Z" })?.status, "completed");
  assert.equal(of({ id: 5, created_at: "2026-11-10T09:00:00Z" })?.error, "Something went wrong inside Octo.");
});
