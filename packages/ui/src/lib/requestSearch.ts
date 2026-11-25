import type { RequestHit } from "@octo/agent-client";

/** Parity B7: searching past requests of every project from the palette. */

/** Characters needed before the harness is asked (one letter matches nearly everything). */
export const SEARCH_MIN = 2;
/** The palette waits for a pause in typing. */
export const SEARCH_DELAY_MS = 200;
export const SEARCH_LIMIT = 8;

/** The query to send, or null when it is too short to ask. */
export function searchQuery(text: string): string | null {
  const q = text.trim().replace(/\s+/g, " ");
  return q.length >= SEARCH_MIN ? q : null;
}

/** One palette row: the snippet as one line; the project it belongs to is the secondary text. */
export function hitRow(hit: RequestHit): { id: string; label: string; detail: string } {
  const line = (hit.snippet.split("\n").find((l) => l.trim() !== "") ?? hit.snippet).replace(/\s+/g, " ").trim();
  return { id: `h:${hit.project_id}:${hit.message_id}`, label: line, detail: hit.project_name };
}
