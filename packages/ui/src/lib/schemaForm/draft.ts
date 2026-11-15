import type { FormValue, InputAnswer } from "@octo/agent-client";
import { checkAnswer, isBlank, MESSAGES, visibleIds } from "./check";
import type { NormalForm, SchemaField } from "./schema";

/**
 * What an open form holds while the person fills it (spec 2026-11-15 §A.3–A.4). A draft is what the control shows: text
 * for strings, numbers (typed digits) and date-times (`datetime-local`, local time), a boolean, a list of choices.
 * Secrets are never drafts: they stay in their inputs and are passed in only at submit.
 */
export type Draft = string | boolean | string[];
export type Drafts = Record<string, Draft>;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Initial drafts from the defaults (a password never has one). */
export function initialDrafts(form: NormalForm): Drafts {
  const out: Drafts = {};
  for (const f of form.fields) {
    if (f.secret) continue;
    const p = f.prop;
    switch (p.type) {
      case "boolean":
        out[f.id] = p.default ?? false;
        break;
      case "array":
        out[f.id] = [...(p.default ?? [])];
        break;
      case "number":
      case "integer":
        out[f.id] = p.default === undefined ? "" : String(p.default);
        break;
      default:
        out[f.id] = p.format === "date-time" && p.default ? toLocalInput(p.default) : (p.default ?? "");
    }
  }
  return out;
}

/** `2026-11-15T14:30:00+01:00` → `2026-11-15T14:30` in this machine's time (what a `datetime-local` control shows). */
export function toLocalInput(rfc3339: string): string {
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A `datetime-local` value → RFC 3339 with this machine's offset (spec §A.1: the UI's local time with the local offset). */
export function fromLocalInput(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** One draft as the value to post, or a reason it cannot be one (typed text that is not a number). */
function valueOf(f: SchemaField, draft: Draft | undefined, secret: string | undefined): { value?: FormValue; problem?: string } {
  const p = f.prop;
  if (f.secret) return secret ? { value: secret } : {};
  if (draft === undefined) return {};
  switch (p.type) {
    case "boolean":
      return typeof draft === "boolean" ? { value: draft } : {};
    case "array":
      return Array.isArray(draft) && draft.length ? { value: [...draft] } : {};
    case "number":
    case "integer": {
      const text = typeof draft === "string" ? draft.trim() : "";
      if (!text) return {};
      if (!NUMBER.test(text)) return { problem: p.type === "integer" ? MESSAGES.integer : MESSAGES.number };
      return { value: Number(text) };
    }
    default: {
      const text = typeof draft === "string" ? draft.trim() : "";
      if (!text) return {};
      if (p.format === "date-time") return { value: fromLocalInput(text) ?? text };
      return { value: text };
    }
  }
}

export type Built = { values: Record<string, FormValue>; problems: Record<string, string>; shown: Set<string> };

/**
 * The answer the drafts make: hidden fields and blank optional ones left out (decision 6: a hidden field is neither
 * checked nor sent), strings trimmed (secrets as typed), numbers parsed. Visibility follows the values built so far, so a
 * condition sees the same typed value the service will.
 */
export function buildValues(form: NormalForm, drafts: Readonly<Drafts>, secrets: Readonly<Record<string, string>> = {}): Built {
  const values: Record<string, FormValue> = {};
  const problems: Record<string, string> = {};
  for (const f of form.fields) {
    if (!visibleIds(form, values).has(f.id)) continue;
    const { value, problem } = valueOf(f, drafts[f.id], secrets[f.id]);
    if (problem) problems[f.id] = problem;
    else if (value !== undefined && !isBlank(f, value)) values[f.id] = value;
  }
  return { values, problems, shown: visibleIds(form, values) };
}

/** Errors by field id for the drafts as they stand: typing problems first, then the answer check. */
export function validateDrafts(form: NormalForm, drafts: Readonly<Drafts>, secrets: Readonly<Record<string, string>> = {}): Record<string, string> {
  const built = buildValues(form, drafts, secrets);
  return { ...checkAnswer(form, built.values), ...built.problems };
}

/** The submit body. */
export function answerOf(form: NormalForm, drafts: Readonly<Drafts>, secrets: Readonly<Record<string, string>> = {}): InputAnswer {
  return { values: buildValues(form, drafts, secrets).values };
}

/** The shown field ids for the drafts (for rendering: a hidden field is not in the DOM). */
export function shownFields(form: NormalForm, drafts: Readonly<Drafts>): Set<string> {
  return buildValues(form, drafts).shown;
}

/** True when the form has a multi-line field: Enter then adds a line, and only Ctrl/Cmd+Enter submits (spec §A.4). */
export function hasMultiline(form: NormalForm): boolean {
  return form.fields.some((f) => f.prop.type === "string" && f.prop["x-octo"]?.multiline === true);
}
