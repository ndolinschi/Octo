/**
 * Addition 9: `/new <text>` gives a request to a NEW main session of the project; the current session neither gets the text
 * nor stops. `/new` alone creates an empty session and opens it (the "New session" button). The runner takes its bridge
 * calls as arguments, so the plan and every failure are testable without a bridge.
 */

/** A new session's title from its first request: the first line, cut at a word boundary to at most `max` characters. */
export function newSessionTitle(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : line.slice(0, max)).replace(/[\s,.;:!?—-]+$/, "")}…`;
}

export type NewSessionDeps = {
  create(input: { title?: string }): Promise<{ session: { id: string; title: string } }>;
  send(sessionId: string, text: string, attachments: readonly string[]): Promise<{ queued?: unknown; waiting_for?: "turn" | "slot" }>;
};

export type NewSessionOutcome =
  /** `/new` alone: open the empty session. */
  | { kind: "open"; sessionId: string }
  /** The request went to the new session; `waiting`: it waits for a free place to start (the parallel limit), not an error. */
  | { kind: "started"; sessionId: string; title: string; waiting: boolean }
  /** Nothing was created: the text stays in the box. */
  | { kind: "create-failed"; error: unknown }
  /** Created, but the request did not go: open the new session with the text in its box (nothing is lost). */
  | { kind: "send-failed"; sessionId: string; error: unknown };

export async function runNewSession(deps: NewSessionDeps, text: string, attachments: readonly string[] = []): Promise<NewSessionOutcome> {
  const body = text.trim();
  let created: { session: { id: string; title: string } };
  try {
    created = await deps.create(body ? { title: newSessionTitle(body) } : {});
  } catch (error) {
    return { kind: "create-failed", error };
  }
  const id = created.session.id;
  if (!body && attachments.length === 0) return { kind: "open", sessionId: id };
  try {
    const sent = await deps.send(id, body, attachments);
    return { kind: "started", sessionId: id, title: created.session.title.trim() || newSessionTitle(body), waiting: sent.waiting_for === "slot" };
  } catch (error) {
    return { kind: "send-failed", sessionId: id, error };
  }
}
