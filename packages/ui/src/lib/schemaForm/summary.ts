import type { AnsweredInput, FormValue, InputAnswer, InputRequest } from "@octo/agent-client";
import { fromFields, parseSchema, type NormalForm, type SchemaField } from "./schema";

/**
 * A request's form and its answered line (spec 2026-11-15 §A.4). Secrets never reach anything here: the answered line
 * shows "•••" for a provided secret, and the optimistic answer drops every secret value before it is kept.
 */

export type RequestForm = { ok: true; form: NormalForm } | { ok: false; reason: string };

/** The request's schema, or its legacy `fields` converted on the client (a harness without schema forms). */
export function formOfRequest(req: InputRequest): RequestForm {
  const origin = req.source?.kind === "tool_server" ? "tool_server" : "tool";
  return parseSchema(req.schema ?? fromFields(req.fields), origin);
}

/** What the card shows for a hidden secret. */
export const SECRET_MASK = "•••";
/** A shown value is cut to this many characters (one line). */
export const SUMMARY_VALUE_MAX = 40;
/** At most this many fields are named; the rest are counted. */
export const SUMMARY_FIELDS_MAX = 5;

export type AnsweredLine = { status: AnsweredInput["status"]; text: string };

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > SUMMARY_VALUE_MAX ? `${chars.slice(0, SUMMARY_VALUE_MAX - 1).join("")}…` : flat;
}

/** A non-secret value in the card's words: choice titles, Yes / No, a date-time without seconds and offset. */
export function shownValue(f: SchemaField | undefined, v: FormValue): string {
  const title = (x: string) => f?.choices?.find((c) => c.const === x)?.title ?? x;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return oneLine(v.map(title).join(", "));
  if (f?.prop.type === "string" && f.prop.format === "date-time") {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v);
    if (m) return `${m[1]} ${m[2]}`;
  }
  return oneLine(title(v));
}

/**
 * The collapsed card: "Answered · Service name: atlas-api · Region: eu-west · Deploy token: •••", "Skipped",
 * "Closed: stopped". Fields follow the form's order; values of secrets are never shown (they are not here to show).
 */
export function answeredSummary(form: NormalForm | null, answered: AnsweredInput): AnsweredLine {
  if (answered.status === "skipped") return { status: "skipped", text: "Skipped" };
  if (answered.status === "cancelled") return { status: "cancelled", text: "Closed: stopped" };
  const fields = form?.fields ?? [];
  const order = [...fields.map((f) => f.id), ...[...answered.provided, ...Object.keys(answered.values)].filter((id) => !fields.some((f) => f.id === id))];
  const parts: string[] = [];
  for (const id of new Set(order)) {
    const f = fields.find((x) => x.id === id);
    const name = f?.title ?? id;
    if (answered.provided.includes(id)) parts.push(`${name}: ${SECRET_MASK}`);
    else if (id in answered.values && !f?.secret) {
      const v = answered.values[id];
      if (v !== undefined) parts.push(`${name}: ${shownValue(f, v)}`);
    }
  }
  const named = parts.slice(0, SUMMARY_FIELDS_MAX);
  if (parts.length > SUMMARY_FIELDS_MAX) named.push(`${parts.length - SUMMARY_FIELDS_MAX} more`);
  return { status: "submitted", text: ["Answered", ...named].join(" · ") };
}

/**
 * What a submit tells the card before `input.resolved` arrives: secret ids as provided, every other value as posted
 * (the same non-secret values the event will carry). No secret value survives this.
 */
export function localAnswered(form: NormalForm, answer: InputAnswer): AnsweredInput {
  if (answer.skip) return { status: "skipped", provided: [], values: {} };
  const values = answer.values ?? {};
  const provided: string[] = [];
  const kept: Record<string, FormValue> = {};
  for (const f of form.fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    if (f.secret) provided.push(f.id);
    else kept[f.id] = Array.isArray(v) ? [...v] : v;
  }
  return { status: "submitted", provided, values: kept };
}

/**
 * The ids a 400 names, for a harness without `error.fields` ("missing required field api_key", "unknown field x"): the
 * harness names fields, never values, so a field id in the message marks that field.
 */
export function fieldsInMessage(message: string, ids: readonly string[]): string[] {
  return ids.filter((id) => new RegExp(`(^|[^\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w.-]|$)`).test(message));
}
