import type { AnsweredInput, InputAnswer, InputField, InputRequest } from "@octo/agent-client";

/**
 * Form cards (decision 43). Secret values never live in React state or in anything returned from here except the answer
 * handed straight to the bridge; the answered summary names fields only.
 */

/** Non-secret values by field id: text, path and select as strings, confirm as a boolean. */
export type FormValues = Record<string, string | boolean>;
/** The harness refuses secrets under 4 bytes (redacting shorter strings would mangle ordinary text). */
export const SECRET_MIN_BYTES = 4;
export const SECRET_MAX_BYTES = 16 * 1024;

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function initialValues(fields: readonly InputField[]): FormValues {
  const v: FormValues = {};
  for (const f of fields) {
    if (f.kind === "secret") continue;
    v[f.id] = f.kind === "confirm" ? false : "";
  }
  return v;
}

/**
 * Field errors by id, in the card's words. A confirm field that is required must be ticked; a select must name one of
 * its options; a secret is 4 bytes to 16 KiB.
 */
export function validate(fields: readonly InputField[], values: FormValues, secrets: Readonly<Record<string, string>>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.kind === "secret") {
      const s = secrets[f.id] ?? "";
      if (!s) {
        if (f.required) errors[f.id] = "Required";
      } else if (utf8Length(s) < SECRET_MIN_BYTES) errors[f.id] = `At least ${SECRET_MIN_BYTES} characters`;
      else if (utf8Length(s) > SECRET_MAX_BYTES) errors[f.id] = "Too long (16 KB at most)";
      continue;
    }
    const v = values[f.id];
    if (f.kind === "confirm") {
      if (f.required && v !== true) errors[f.id] = "Confirm to continue";
      continue;
    }
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) {
      if (f.required) errors[f.id] = f.kind === "select" ? "Choose one" : "Required";
    } else if (f.kind === "select" && !(f.options ?? []).includes(text)) errors[f.id] = "Choose one of the options";
  }
  return errors;
}

/** The submit body: every answered field (secrets included, unchanged), empty optional ones left out. */
export function buildAnswer(fields: readonly InputField[], values: FormValues, secrets: Readonly<Record<string, string>>): InputAnswer {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.kind === "secret") {
      const s = secrets[f.id];
      if (s) out[f.id] = s;
      continue;
    }
    const v = values[f.id];
    if (typeof v === "boolean") out[f.id] = v;
    else if (typeof v === "string" && v.trim()) out[f.id] = v.trim();
  }
  return { values: out };
}

/**
 * The ids a 400 names ("missing required field api_key", "unknown field x"): the harness names fields, never values, so
 * a field id in the message marks that field.
 */
export function fieldsInError(message: string, fields: readonly InputField[]): string[] {
  return fields.filter((f) => new RegExp(`(^|[^\\w.-])${f.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w.-]|$)`).test(message)).map((f) => f.id);
}

export type AnsweredLine = { status: AnsweredInput["status"]; text: string };

/** The collapsed card: names only — "API key provided · Region, Environment answered", "Skipped", "Closed". */
export function answeredLine(req: InputRequest, answered: AnsweredInput): AnsweredLine {
  if (answered.status === "skipped") return { status: "skipped", text: "Skipped" };
  if (answered.status === "cancelled") return { status: "cancelled", text: "Closed: stopped" };
  const label = (id: string) => req.fields.find((f) => f.id === id)?.label ?? id;
  const provided = answered.provided.map(label);
  const given = Object.keys(answered.values)
    .filter((id) => !answered.provided.includes(id))
    .map(label);
  const parts: string[] = [];
  if (provided.length) parts.push(`${list(provided)} provided`);
  if (given.length) parts.push(`${list(given)} answered`);
  return { status: "submitted", text: parts.join(" · ") || "Submitted" };
}

function list(names: string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/**
 * What a submit tells the card before the `input.resolved` event arrives: secret ids as provided, non-secret values
 * by id — with their values dropped, so the optimistic summary holds names only too.
 */
export function localAnswered(fields: readonly InputField[], answer: InputAnswer): AnsweredInput {
  if (answer.skip) return { status: "skipped", provided: [], values: {} };
  const values = answer.values ?? {};
  const provided = fields.filter((f) => f.kind === "secret" && f.id in values).map((f) => f.id);
  const named: Record<string, string | boolean> = {};
  for (const f of fields) if (f.kind !== "secret" && f.id in values) named[f.id] = true;
  return { status: "submitted", provided, values: named };
}
