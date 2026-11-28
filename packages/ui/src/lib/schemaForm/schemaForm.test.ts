import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FormSchema, InputField, InputRequest } from "@octo/agent-client";
import { attentionLine, checkAnswer, MESSAGES } from "./check";
import { answerOf, buildValues, fromLocalInput, hasMultiline, initialDrafts, shownFields, toLocalInput, validateDrafts } from "./draft";
import { patternMatches, patternRunnable } from "./pattern";
import { fromFields, parseSchema, type NormalForm } from "./schema";
import { answeredSummary, fieldsInMessage, formOfRequest, localAnswered } from "./summary";
import { widgetFor } from "./widgets";

type Fixture = { forms: Record<string, unknown>; cases: { name: string; form: string; values: Record<string, unknown>; errors: string[] }[] };
const fixture = JSON.parse(readFileSync(new URL("../../../../agent-client/src/fixtures/forms.json", import.meta.url), "utf8")) as Fixture;

function form(raw: unknown, origin: "tool" | "block" = "tool"): NormalForm {
  const r = parseSchema(raw, origin);
  if (!r.ok) throw new Error(r.reason);
  return r.form;
}

test("criterion 8: the client check gives the fixture's verdict on every case (shared with the Go check)", () => {
  assert.ok(fixture.cases.length >= 40);
  for (const c of fixture.cases) {
    const f = form(fixture.forms[c.form]);
    assert.deepEqual(Object.keys(checkAnswer(f, c.values)).sort(), c.errors, c.name);
  }
});

const SIGNIN: FormSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", title: "Email" },
    password: { type: "string", format: "password", title: "Password", minLength: 8 },
    remember: { type: "boolean", title: "Keep me signed in", default: true },
  },
};

test("parse: order is normalised to list every property; titles fall back to ids", () => {
  const f = form({ ...SIGNIN, "x-octo": { order: ["password"] } });
  assert.deepEqual(
    f.fields.map((x) => x.id),
    ["password", "email", "remember"],
  );
  assert.deepEqual(f.schema["x-octo"]?.order, ["password", "email", "remember"]);
  assert.equal(form({ type: "object", properties: { n: { type: "string" } } }).fields[0]?.title, "n");
});

test("parse: refusals name the cause", () => {
  const refused = (raw: unknown, origin: "tool" | "block" = "tool") => {
    const r = parseSchema(raw, origin);
    return r.ok ? "accepted" : r.reason;
  };
  const one = (prop: unknown) => ({ type: "object", properties: { a: prop } });
  assert.match(refused(one({ type: "object", properties: {} })), /not supported/);
  assert.match(refused(one({ $ref: "#/x" })), /\$ref/);
  assert.match(refused({ type: "object", properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, { type: "string" }])) }), /1 to 20/);
  assert.match(refused(one({ type: "string", enum: Array.from({ length: 50 }, (_, i) => `${i}${"x".repeat(700)}`) })), /32 KB/);
  assert.match(refused(one({ type: "string", pattern: "(?=a)b" })), /look-around/);
  assert.match(refused(one({ type: "string", format: "password" }), "block"), /only an agent/);
  assert.match(
    refused({ type: "object", properties: { a: { type: "string", "x-octo": { visible_when: { field: "b", equals: 1 } } }, b: { type: "boolean" } } }),
    /earlier property/,
  );
  assert.match(refused(one({ type: "string", enum: Array.from({ length: 51 }, (_, i) => `v${i}`) })), /1 to 50/);
  assert.match(refused({ type: "object", properties: { "1a": { type: "string" } } }), /must start with a letter/);
  assert.match(refused(one({ type: "integer", minimum: 5, maximum: 1 })), /minimum is above maximum/);
  assert.match(refused(one({ type: "string", enum: ["a"], default: "b" })), /default is not one of the choices/);
  assert.match(refused({ type: "object", required: ["zz"], properties: { a: { type: "string" } } }), /not a property/);
  assert.equal(refused(SIGNIN), "accepted");
});

test("fields → schema: the five legacy kinds", () => {
  const fields: InputField[] = [
    { id: "name", label: "Service name", kind: "text", required: true, help: "Lower case" },
    { id: "token", label: "Deploy token", kind: "secret", required: true },
    { id: "region", label: "Region", kind: "select", options: ["eu-west", "us-east"], required: true },
    { id: "smoke", label: "Run smoke tests", kind: "confirm" },
    { id: "ok", label: "I understand", kind: "confirm", required: true },
    { id: "dir", label: "Folder", kind: "path" },
  ];
  const s = fromFields(fields);
  assert.deepEqual(s.required, ["name", "token", "region", "ok"]);
  assert.deepEqual(s.properties.name, { title: "Service name", description: "Lower case", type: "string" });
  assert.deepEqual(s.properties.token, { title: "Deploy token", type: "string", format: "password" });
  assert.deepEqual(s.properties.region, { title: "Region", type: "string", enum: ["eu-west", "us-east"] });
  assert.deepEqual(s.properties.smoke, { title: "Run smoke tests", type: "boolean" });
  assert.deepEqual(s.properties.ok, { title: "I understand", type: "boolean", "x-octo": { accept: true } });
  assert.deepEqual(s.properties.dir, { title: "Folder", type: "string", "x-octo": { widget: "path" } });
  const f = form(s);
  assert.deepEqual(f.fields.map(widgetFor), ["text", "password", "segments", "checkbox", "checkbox", "path"]);
  // A request without schema (an older harness) is converted on the client.
  const req: InputRequest = { id: "i", agent_id: "a", agent_label: "x", turn_id: 1, title: "t", reason: "", fields, created_at: "" };
  const r = formOfRequest(req);
  assert.deepEqual(r.ok ? r.form.fields.length : r.reason, 6);
});

test("criterion 9: widgets by schema — 3-choice one-of segments, 6-choice Select, many-of checkboxes, formats", () => {
  const f = form(fixture.forms.region);
  assert.deepEqual(f.fields.map(widgetFor), ["select", "segments"]);
  assert.deepEqual(form(fixture.forms.checks).fields.map(widgetFor), ["checkboxes", "checkboxes"]);
  assert.deepEqual(form(fixture.forms.rollout).fields.map(widgetFor), ["number", "datetime", "date", "textarea", "text", "checkbox", "number"]);
  assert.deepEqual(form(SIGNIN).fields.map(widgetFor), ["email", "password", "checkbox"]);
  // A short list (2–4) with a long label renders as stacked choice buttons (segments never truncate; 5+ stays Select).
  const long = form({
    type: "object",
    properties: {
      r: {
        type: "string",
        oneOf: [
          { const: "a", title: "Approved — proceed to the implementation plan" },
          { const: "b", title: "Changes needed (I'll describe them)" },
        ],
      },
      many: {
        type: "string",
        enum: ["a", "b", "c", "d", "e"],
      },
    },
  });
  assert.deepEqual(long.fields.map(widgetFor), ["choices", "select"]);
});

test("defaults fill the drafts; a password never has one", () => {
  const f = form(fixture.forms.rollout);
  assert.deepEqual(initialDrafts(f), { replicas: "2", window: "", start: "", notes: "", slug: "", canary: false, canary_percent: "" });
  assert.deepEqual(initialDrafts(form(SIGNIN)), { email: "", remember: true });
  assert.deepEqual(initialDrafts(form({ type: "object", properties: { c: { type: "array", items: { type: "string", enum: ["a", "b"] }, default: ["b"] } } })), {
    c: ["b"],
  });
});

test("visibility: a hidden field is not shown, not checked and not sent", () => {
  const f = form(fixture.forms.rollout);
  const drafts = { ...initialDrafts(f), canary_percent: "99" };
  assert.equal(shownFields(f, drafts).has("canary_percent"), false);
  assert.deepEqual(validateDrafts(f, drafts), {});
  assert.deepEqual(answerOf(f, drafts), { values: { replicas: 2, canary: false } });
  const on = { ...drafts, canary: true };
  assert.equal(shownFields(f, on).has("canary_percent"), true);
  assert.deepEqual(validateDrafts(f, on), { canary_percent: "Enter a number from 1 to 50" });
  assert.deepEqual(validateDrafts(f, { ...on, canary_percent: "" }), { canary_percent: "Required" });
});

test("each rule's message in the card's words", () => {
  const f = form(fixture.forms.rollout);
  const d = initialDrafts(f);
  assert.equal(validateDrafts(f, { ...d, replicas: "2.5" }).replicas, "Enter a whole number");
  assert.equal(validateDrafts(f, { ...d, replicas: "two" }).replicas, "Enter a whole number");
  assert.equal(validateDrafts(f, { ...d, replicas: "0" }).replicas, "Enter a number from 1 to 10");
  assert.equal(validateDrafts(f, { ...d, replicas: "" }).replicas, "Required");
  assert.equal(validateDrafts(f, { ...d, slug: "Atlas" }).slug, "Doesn't match the expected format");
  assert.equal(validateDrafts(f, { ...d, notes: "x".repeat(201) }).notes, "Use 200 characters or fewer");
  assert.equal(validateDrafts(f, { ...d, start: "2026-02-30" }).start, "Enter a date like 2026-11-15");
  const s = form(SIGNIN);
  assert.deepEqual(validateDrafts(s, { email: "x", remember: true }, {}), { email: MESSAGES.email, password: "Required" });
  assert.equal(validateDrafts(s, { email: "a@b.co", remember: true }, { password: "abc" }).password, "Use 8 characters or more");
  assert.equal(validateDrafts(form(fixture.forms.region), { region: "", env: "" }).region, "Choose one");
  assert.equal(validateDrafts(form(fixture.forms.checks), { checks: [], regions: [] }).checks, "Choose at least 1");
  assert.equal(validateDrafts(form(fixture.forms.checks), { checks: ["unit", "lint", "e2e", "types"], regions: [] }).checks, "Choose at most 3");
  assert.equal(validateDrafts(form(fixture.forms.site), { env: "dev", url: "atlas", tier: "" }).url, MESSAGES.uri);
  assert.equal(validateDrafts(form(fixture.forms.accept), { ok: false }).ok, "Tick this to continue");
  assert.equal(attentionLine(1), "1 field needs attention");
  assert.equal(attentionLine(2), "2 fields need attention");
});

test("answer: trimmed text, typed numbers, date-time with the local offset, secrets as typed", () => {
  const f = form(fixture.forms.rollout);
  const built = buildValues(f, { ...initialDrafts(f), replicas: " 4 ", notes: "  two\nlines ", window: "2026-11-15T14:30" });
  assert.equal(built.values.replicas, 4);
  assert.equal(built.values.notes, "two\nlines");
  assert.match(String(built.values.window), /^2026-11-15T14:30:00[+-]\d{2}:\d{2}$/);
  assert.equal(toLocalInput(fromLocalInput("2026-11-15T14:30") ?? ""), "2026-11-15T14:30");
  assert.deepEqual(answerOf(form(SIGNIN), { email: " a@b.co ", remember: false }, { password: " pass word " }), {
    values: { email: "a@b.co", password: " pass word ", remember: false },
  });
  assert.equal(hasMultiline(f), true);
  assert.equal(hasMultiline(form(SIGNIN)), false);
});

test("criterion 12: the answered summary never holds a secret", () => {
  const s = form(SIGNIN);
  const answer = { values: { email: "a@b.co", password: "hunter2222", remember: true } };
  const local = localAnswered(s, answer);
  assert.equal(JSON.stringify(local).includes("hunter2222"), false);
  assert.deepEqual(local, { status: "submitted", provided: ["password"], values: { email: "a@b.co", remember: true } });
  assert.deepEqual(answeredSummary(s, local), { status: "submitted", text: "Answered · Email: a@b.co · Password: ••• · Keep me signed in: Yes" });
  // Even a resolved event that wrongly carried a password value shows the mask, never the value.
  assert.equal(answeredSummary(s, { status: "submitted", provided: [], values: { password: "leak" } }).text.includes("leak"), false);
  assert.equal(answeredSummary(s, { status: "skipped", provided: [], values: {} }).text, "Skipped");
  assert.equal(answeredSummary(s, { status: "cancelled", provided: [], values: {} }).text, "Closed: stopped");
  const region = form(fixture.forms.region);
  assert.equal(
    answeredSummary(region, { status: "submitted", provided: [], values: { region: "eu-west", env: "prod" } }).text,
    "Answered · Region: Europe (Ireland) · Environment: Production",
  );
  const checks = form(fixture.forms.checks);
  assert.equal(
    answeredSummary(checks, { status: "submitted", provided: [], values: { checks: ["unit", "e2e"] } }).text,
    "Answered · Checks: Unit tests, End-to-end",
  );
  const long = answeredSummary(form(fixture.forms.rollout), {
    status: "submitted",
    provided: [],
    values: { notes: "a ".repeat(60), window: "2026-11-15T14:30:00+01:00" },
  });
  assert.equal(long.text, `Answered · Deploy window starts: 2026-11-15 14:30 · Release notes: ${"a ".repeat(19)}a…`);
});

test("a 400 from an older harness names field ids in its message", () => {
  assert.deepEqual(fieldsInMessage('field "api_key" is required', ["api_key", "region"]), ["api_key"]);
  assert.deepEqual(fieldsInMessage("value of region is not an option", ["api_key", "region"]), ["region"]);
});

test("pattern: a hostile expression is never run in the tab, and does not hang it", () => {
  for (const evil of ["(a+)+$", "(a*)*b", "(a|aa)+$", "^(\\w+\\s?)*$", "\\d*\\d*\\d*x"]) assert.equal(patternRunnable(evil), false, evil);
  const started = Date.now();
  assert.equal(patternMatches("(a+)+$", `${"a".repeat(40)}!`), null);
  assert.ok(Date.now() - started < 100);
  assert.equal(patternMatches("^[a-z][a-z0-9-]*$", "atlas-api"), true);
  assert.equal(patternMatches("^[a-z][a-z0-9-]*$", "Atlas"), false);
  assert.equal(patternMatches("^[a-z]+$", "a".repeat(2000)), null);
  // Not compilable here (RE2 spelling): the service decides.
  assert.equal(patternMatches("(?P<n>a)", "a"), null);
});
