import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, ChangeDetail, InputField, InputRequest } from "@octo/agent-client";
import { answerFor, approvalDeadline, approvalItems, diffBlocks, formatCountdown, keyAction, optionAnswer, resolutionCause, resolutionLabel } from "./approval";
import { answeredLine, buildAnswer, fieldsInError, initialValues, localAnswered, validate } from "./form";
import { queueLine, queueView, withoutQueued } from "./queue";
import { diffLayout, earlierRequestLabel, netDiff, netIds, revertOrder, revertProblem, sourceLabel, splitPath, turnRevertOrder } from "./changes";

const approval = (id: string, created_at: string): Approval => ({
  id,
  agent_id: "a1",
  agent_label: "coder",
  turn_id: 1,
  kind: "write",
  title: `Write ${id}`,
  detail: {},
  created_at,
});

test("countdown: deadline from created_at, mm:ss and h:mm:ss, never negative", () => {
  assert.equal(approvalDeadline("2026-11-11T10:00:00Z", 60_000), Date.parse("2026-11-11T10:01:00Z"));
  assert.equal(approvalDeadline("2026-11-11T10:00:00Z", 0), null);
  assert.equal(approvalDeadline("not a date"), null);
  assert.equal(formatCountdown(29 * 60_000 + 41_000), "29:41");
  assert.equal(formatCountdown(9_000), "0:09");
  assert.equal(formatCountdown(3_723_000), "1:02:03");
  assert.equal(formatCountdown(-5), "0:00");
  assert.equal(formatCountdown(500), "0:01");
});

test("keys: A and Enter allow, D denies; not in a field, not with modifiers", () => {
  const none = { ctrl: false, meta: false, alt: false };
  assert.equal(keyAction("a", none, false), "allow");
  assert.equal(keyAction("Enter", none, false), "allow");
  assert.equal(keyAction("D", none, false), "deny");
  assert.equal(keyAction("a", none, true), null);
  assert.equal(keyAction("a", { ...none, meta: true }, false), null);
  assert.equal(keyAction("x", none, false), null);
});

test("answers: a note only with a denial; ACP options map to allow / deny with their id", () => {
  assert.deepEqual(answerFor("allow", "ignored"), { decision: "allow" });
  assert.deepEqual(answerFor("deny", "  use pnpm  "), { decision: "deny", note: "use pnpm" });
  assert.deepEqual(answerFor("deny", "   "), { decision: "deny" });
  assert.deepEqual(answerFor("allow_for_turn"), { decision: "allow_for_turn" });
  assert.deepEqual(optionAnswer({ id: "o1", label: "Always", kind: "allow_always" }), { decision: "allow", option_id: "o1" });
  assert.deepEqual(optionAnswer({ id: "o2", label: "No", kind: "reject_once" }, "why"), { decision: "deny", option_id: "o2", note: "why" });
});

test("resolution: ours wins, deny at the deadline is the timer, deny while stopping is the cancel", () => {
  const local = { decision: "allow" as const, by: "you" as const };
  assert.equal(resolutionCause("allow", { local, now: 0, deadline: 0, turnStopped: false }), local);
  assert.equal(resolutionCause("deny", { local: undefined, now: 100_000, deadline: 100_500, turnStopped: false }).by, "timeout");
  assert.equal(resolutionCause("deny", { local: undefined, now: 0, deadline: 100_000, turnStopped: true }).by, "cancelled");
  assert.equal(resolutionCause("allow", { local: undefined, now: 0, deadline: null, turnStopped: true }).by, "elsewhere");
  assert.equal(resolutionLabel({ decision: "allow_for_turn", by: "you" }), "Allowed for this turn");
  assert.equal(resolutionLabel({ decision: "allow_always", by: "you", rule: "git status" }), "Always allowed");
  assert.deepEqual(answerFor("allow_always", "ignored"), { decision: "allow_always" });
  assert.equal(resolutionLabel({ decision: "deny", by: "timeout" }), "Denied automatically");
  assert.equal(resolutionLabel({ decision: "allow", by: "elsewhere" }), "Allowed once elsewhere");
});

test("approval items: pending and resolved, oldest first; seen-but-unresolved ones that left are dropped", () => {
  const a = approval("a", "2026-11-11T10:00:02Z");
  const b = approval("b", "2026-11-11T10:00:01Z");
  const c = approval("c", "2026-11-11T10:00:03Z");
  const items = approvalItems([a], [a, b, c], { b: { decision: "deny", by: "you" } });
  assert.deepEqual(
    items.map((i) => [i.approval.id, i.resolution?.decision ?? null]),
    [
      ["b", "deny"],
      ["a", null],
    ],
  );
});

test("diff blocks: share of added and removed, both shown when both exist", () => {
  assert.deepEqual(diffBlocks(0, 0), ["none", "none", "none", "none", "none"]);
  assert.deepEqual(diffBlocks(100, 0), ["add", "add", "add", "add", "add"]);
  assert.deepEqual(diffBlocks(1, 1), ["add", "del", "none", "none", "none"]);
  assert.equal(diffBlocks(50, 50).filter((b) => b === "add").length, 3);
});

const fields: InputField[] = [
  { id: "api_key", label: "API key", kind: "secret", required: true },
  { id: "region", label: "Region", kind: "select", options: ["eu", "us"], required: true },
  { id: "note", label: "Note", kind: "text" },
  { id: "ok", label: "I understand", kind: "confirm", required: true },
];

test("form: initial values hold no secret; validation names each problem", () => {
  const v = initialValues(fields);
  assert.deepEqual(v, { region: "", note: "", ok: false });
  assert.deepEqual(validate(fields, v, {}), { api_key: "Required", region: "Choose one", ok: "Confirm to continue" });
  assert.deepEqual(validate(fields, { region: "mars", note: "", ok: true }, { api_key: "abc" }), {
    api_key: "At least 4 characters",
    region: "Choose one of the options",
  });
  assert.deepEqual(validate(fields, { region: "eu", note: "", ok: true }, { api_key: "sk-1234" }), {});
});

test("form: the answer carries the secret once, trims text, drops empty optional fields", () => {
  const ans = buildAnswer(fields, { region: "eu", note: "  ", ok: true }, { api_key: "sk-1234" });
  assert.deepEqual(ans, { values: { api_key: "sk-1234", region: "eu", ok: true } });
});

test("form: the optimistic and the answered summary hold names only", () => {
  const req: InputRequest = { id: "f", agent_id: "a", agent_label: "x", turn_id: 1, title: "t", reason: "", fields, created_at: "" };
  const local = localAnswered(fields, { values: { api_key: "sk-1234", region: "eu", ok: true } });
  assert.equal(JSON.stringify(local).includes("sk-1234"), false);
  assert.equal(JSON.stringify(local).includes("eu"), false);
  assert.deepEqual(answeredLine(req, local), { status: "submitted", text: "API key provided · Region, I understand answered" });
  assert.equal(answeredLine(req, { status: "skipped", provided: [], values: {} }).text, "Skipped");
  assert.deepEqual(fieldsInError("missing required field api_key", fields), ["api_key"]);
  assert.deepEqual(fieldsInError("value of region is not an option", fields), ["region"]);
});

test("queue: one line per message, folds past three", () => {
  assert.equal(queueLine("\n  fix   the\ttests \nand more"), "fix the tests");
  assert.deepEqual(queueView([1, 2, 3], false), { shown: [1, 2, 3], hidden: 0 });
  assert.deepEqual(queueView([1, 2, 3, 4, 5], false), { shown: [1, 2], hidden: 3 });
  assert.deepEqual(queueView([1, 2, 3, 4, 5], true), { shown: [1, 2, 3, 4, 5], hidden: 0 });
  assert.deepEqual(withoutQueued([{ id: "q1", text: "", created_at: "" }], "q1"), []);
});

const detail = (over: Partial<ChangeDetail>): ChangeDetail => ({
  id: 1,
  turn_id: 1,
  agent_id: "a",
  folder: "app",
  path: "a.ts",
  kind: "modified",
  added: 1,
  removed: 1,
  created_at: "",
  note: "",
  source: "write_file",
  before: "a",
  after: "b",
  diff_available: true,
  ...over,
});

test("changes: revert newest first, net diff from first before to last after", () => {
  assert.deepEqual(revertOrder({ change_ids: [3, 9, 5] }), [9, 5, 3]);
  assert.deepEqual(turnRevertOrder({ files: [{ change_ids: [1, 4] }, { change_ids: [2] }] }), [4, 2, 1]);
  assert.deepEqual(netIds({ change_ids: [7, 3] }), { first: 3, last: 7 });
  assert.equal(netIds({ change_ids: [] }), null);
  const file = { kind: "modified" as const, note: "" as const };
  assert.deepEqual(netDiff(file, detail({ before: "one" }), detail({ after: "three" })), { before: "one", after: "three" });
  assert.deepEqual(netDiff({ kind: "created", note: "" }, detail({ before: null }), detail({ after: "x" })), { before: "", after: "x" });
  assert.deepEqual(netDiff({ kind: "modified", note: "too_large" }, detail({ diff_available: false }), detail({})), {
    unavailable: "Too large to diff (over 2 MiB).",
  });
});

test("changes: 409s become a next step; sources and layout", () => {
  const err = (code: string) => Object.assign(new Error("x"), { code });
  assert.equal(revertProblem(err("revert_unavailable")).kind, "revert_unavailable");
  assert.equal(revertProblem(err("file_changed")).kind, "file_changed");
  assert.match(revertProblem(new Error("network down")).message, /Try again/);
  assert.equal(sourceLabel("write_file"), "tool");
  assert.equal(sourceLabel("acp_turn"), "agent");
  assert.equal(diffLayout(1440, 900), "split");
  assert.equal(diffLayout(1099, 900), "unified");
  assert.equal(diffLayout(1440, 500), "unified");
  assert.deepEqual(splitPath("src/a/b.ts"), { dir: "src/a", name: "b.ts" });
  assert.deepEqual(splitPath("b.ts"), { dir: "", name: "b.ts" });
});

test("changes: a turn whose request is not loaded is an earlier request with the time of its first change, never a number", () => {
  const now = Date.parse("2026-11-13T12:00:00");
  const at = (created_at: string) => ({ created_at });
  assert.equal(earlierRequestLabel({ files: [] }, now), "Earlier request");
  assert.equal(earlierRequestLabel({ files: [at("")] } as never, now), "Earlier request");
  const label = earlierRequestLabel({ files: [at("2026-11-13T10:05:00"), at("2026-11-13T09:30:00")] } as never, now);
  assert.match(label, /^Earlier request · Today 9:30/);
});
