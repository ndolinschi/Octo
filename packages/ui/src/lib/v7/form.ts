import type { AnsweredInput, InputRequest } from "@octo/agent-client";
import { answeredSummary, formOfRequest, type AnsweredLine } from "../schemaForm/summary";

/**
 * Form cards (decision 43, rebuilt on schema forms by spec 2026-11-15 §A): the card renders `lib/schemaForm`; what stays
 * here is the secret-length rule the "Change" row of an answered card uses, and the answered line by request.
 */

/** The harness refuses secrets under 4 bytes (redacting shorter strings would mangle ordinary text). */
export const SECRET_MIN_BYTES = 4;

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The collapsed card's line for a request ("Answered · Region: eu-west · Deploy token: •••", "Skipped", "Closed: stopped"). */
export function answeredLine(req: InputRequest, answered: AnsweredInput): AnsweredLine {
  const parsed = formOfRequest(req);
  return answeredSummary(parsed.ok ? parsed.form : null, answered);
}
