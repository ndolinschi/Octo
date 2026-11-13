/**
 * What a new session keeps and what it leaves behind, in the person's words. Every claim is checked against the harness
 * (`apps/harness/docs/sessions.md`, "What carries over"): `/clear` and "New session" are one operation.
 */

/** Said once, in the "New session" popover and nowhere else at length. */
export const CARRIED =
  "A summary of this session, your open tasks, the project's notes and instructions. Earlier sessions and what the project remembered stay stored and searchable.";
export const NOT_CARRIED = "The conversation itself. The new session starts without the earlier messages.";

/** The one quiet line on the first screen of an empty session that followed another one. */
export const EMPTY_SESSION_LINE =
  "No requests yet. This session starts from a summary of the last one, your open tasks and the project's notes; the earlier conversation is stored and searchable.";
/** An empty session that followed nothing. */
export const EMPTY_FIRST_LINE = "No requests yet. What you ask in the conversation starts this session.";
