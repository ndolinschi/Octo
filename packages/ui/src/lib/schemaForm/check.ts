import type { FormCondition } from "@octo/agent-client";
import { LIMITS, type NormalForm, type SchemaField } from "./schema";
import { patternMatches } from "./pattern";

/**
 * The answer check (spec 2026-11-15 §A.3): the same rules as the harness's `inputs.CheckAnswer`, messages in the card's
 * words. Verdicts agree with the Go side on the shared fixture (`packages/agent-client/src/fixtures/forms.json`); the one
 * deliberate gap is `pattern`, which the client skips when running it could hang the tab (see `pattern.ts`).
 */

export const MESSAGES = {
  required: "Required",
  chooseOne: "Choose one",
  notAChoice: "Choose one of the options",
  email: "Enter an email address like name@example.com",
  uri: "Enter a web address starting with https://",
  date: "Enter a date like 2026-11-15",
  dateTime: "Enter a date and a time",
  integer: "Enter a whole number",
  number: "Enter a number",
  pattern: "Doesn't match the expected format",
  accept: "Tick this to continue",
  tooLong: "Too long (16 KB at most)",
  wrongType: "This value has the wrong type",
  unknown: "Not part of this form",
  hidden: "Not shown in this form",
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minLength = (n: number) => `Use ${plural(n, "character")} or more`;
const maxLength = (n: number) => `Use ${plural(n, "character")} or fewer`;
const atLeast = (n: number) => `Choose at least ${n}`;
const atMost = (n: number) => `Choose at most ${n}`;
const fmt = (n: number) => String(n);

function range(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `Enter a number from ${fmt(min)} to ${fmt(max)}`;
  if (min !== undefined) return `Enter a number of ${fmt(min)} or more`;
  return `Enter a number of ${fmt(max ?? 0)} or less`;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s.][^@\s]*$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const runes = (s: string) => Array.from(s).length;

function realDate(y: string, m: string, d: string): boolean {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isEmail(s: string): boolean {
  return EMAIL.test(s);
}
export function isUri(s: string): boolean {
  return URI.test(s);
}
export function isDate(s: string): boolean {
  const m = DATE.exec(s);
  return m !== null && realDate(m[1] ?? "", m[2] ?? "", m[3] ?? "");
}
export function isDateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  return m !== null && realDate(m[1] ?? "", m[2] ?? "", m[3] ?? "");
}

/** Whether a condition holds for `values` (an absent value matches nothing). */
export function conditionHolds(cond: FormCondition, values: Readonly<Record<string, unknown>>): boolean {
  const v = values[cond.field];
  if (v === undefined) return false;
  const wanted = Array.isArray(cond.equals) ? cond.equals : [cond.equals];
  return wanted.some((w) => w === v);
}

/** Field ids shown for these values, in order: a field whose condition's field is hidden is hidden too (it has no value). */
export function visibleIds(form: NormalForm, values: Readonly<Record<string, unknown>>): Set<string> {
  const shown = new Set<string>();
  for (const f of form.fields) {
    if (!f.condition) shown.add(f.id);
    else if (shown.has(f.condition.field) && conditionHolds(f.condition, values)) shown.add(f.id);
  }
  return shown;
}

/** An empty string (after trimming, except for a secret) or an empty list counts as not given. */
export function isBlank(f: SchemaField, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return (f.secret ? v : v.trim()) === "";
  return Array.isArray(v) && v.length === 0;
}

/** Errors by property id for an answer as it would be posted; empty when the answer is accepted. */
export function checkAnswer(form: NormalForm, values: Readonly<Record<string, unknown>>): Record<string, string> {
  const errors: Record<string, string> = {};
  const known = new Set(form.fields.map((f) => f.id));
  for (const id of Object.keys(values)) if (!known.has(id)) errors[id] = MESSAGES.unknown;
  const shown = visibleIds(form, values);
  for (const f of form.fields) {
    const v = values[f.id];
    if (!shown.has(f.id)) {
      if (v !== undefined) errors[f.id] = MESSAGES.hidden;
      continue;
    }
    const problem = checkValue(f, v);
    if (problem) errors[f.id] = problem;
  }
  return errors;
}

/** One visible field's problem, or null. */
export function checkValue(f: SchemaField, v: unknown): string | null {
  const p = f.prop;
  if (p.type === "boolean") {
    const accept = p["x-octo"]?.accept === true;
    if (v === undefined) return accept ? MESSAGES.accept : f.required ? MESSAGES.required : null;
    if (typeof v !== "boolean") return MESSAGES.wrongType;
    return accept && !v ? MESSAGES.accept : null;
  }
  if (isBlank(f, v)) {
    if (!f.required) {
      // A many-of list given empty still meets its own minItems only when it asks for none.
      if (p.type === "array" && Array.isArray(v) && (p.minItems ?? 0) > 0) return atLeast(p.minItems ?? 1);
      return null;
    }
    if (p.type === "array") return atLeast(Math.max(1, p.minItems ?? 1));
    return f.choices ? MESSAGES.chooseOne : MESSAGES.required;
  }
  switch (p.type) {
    case "string": {
      if (typeof v !== "string") return MESSAGES.wrongType;
      if (!f.secret && bytes(v) > LIMITS.textBytes) return MESSAGES.tooLong;
      if (f.choices) return f.choices.some((c) => c.const === v) ? null : MESSAGES.notAChoice;
      if (p.enum !== undefined || p.oneOf !== undefined) return null;
      if (f.secret) {
        // The secret store's own floor (4 bytes) and the schema's minLength: the higher one is what the person must meet.
        if (bytes(v) < LIMITS.secretMinBytes) return minLength(Math.max(LIMITS.secretMinBytes, p.minLength ?? 0));
        if (bytes(v) > LIMITS.secretMaxBytes) return MESSAGES.tooLong;
      }
      if (p.minLength !== undefined && runes(v) < p.minLength) return minLength(p.minLength);
      if (p.maxLength !== undefined && runes(v) > p.maxLength) return maxLength(p.maxLength);
      if (p.format === "email" && !isEmail(v)) return MESSAGES.email;
      if (p.format === "uri" && !isUri(v)) return MESSAGES.uri;
      if (p.format === "date" && !isDate(v)) return MESSAGES.date;
      if (p.format === "date-time" && !isDateTime(v)) return MESSAGES.dateTime;
      if (p.pattern !== undefined && patternMatches(p.pattern, v) === false) return MESSAGES.pattern;
      return null;
    }
    case "number":
    case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) return MESSAGES.wrongType;
      if (p.type === "integer" && !Number.isInteger(v)) return MESSAGES.integer;
      if ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum)) return range(p.minimum, p.maximum);
      return null;
    }
    case "array": {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return MESSAGES.wrongType;
      const choices = f.choices ?? [];
      if (!v.every((x) => choices.some((c) => c.const === x))) return MESSAGES.notAChoice;
      if (new Set(v).size !== v.length) return "Choose each option once";
      if (p.minItems !== undefined && v.length < p.minItems) return atLeast(p.minItems);
      if (p.maxItems !== undefined && v.length > p.maxItems) return atMost(p.maxItems);
      return null;
    }
  }
}

/** "1 field needs attention", "2 fields need attention" (spec §A.4: announced on a failed submit). */
export function attentionLine(count: number): string {
  return count === 1 ? "1 field needs attention" : `${count} fields need attention`;
}
