import { BridgeError, type Bridge } from "./client";
import type { ContextBreakdown } from "./types";

/**
 * Parallel sessions (spec section 9): the same `Bridge`, addressed to one main session. The project routes that act on the
 * default session (`sendOrQueueMessage`, cancel, queue, context, compact, rewind, plan, export, clear, the approval and form lists) go to
 * that session's own routes; everything else is the bridge as it is. A view of one session (a conversation tab) uses it
 * in place of the project's bridge, so its composer, queue, context ring and slash commands need no session argument.
 *
 * `sendMessage` (the plain send that refuses to queue) stays the project's: a session's view sends with `sendOrQueueMessage`.
 * `clearConversation` answers like the project route, with `session_id` = the session the clear made (the tab follows it)
 * and `previous_session_id` = this one.
 */
const SCOPED = [
  ["getQueue", "getSessionQueue"],
  ["editQueued", "editSessionQueued"],
  ["removeQueued", "removeSessionQueued"],
  ["clearQueue", "clearSessionQueue"],
  ["resumeQueue", "resumeSessionQueue"],
  ["sendQueuedNow", "sendSessionQueuedNow"],
  ["getContextOverview", "getSessionContext"],
  ["compactNow", "compactSession"],
  ["rewind", "rewindSession"],
  ["getLatestPlan", "getSessionLatestPlan"],
  ["exportConversationUrl", "exportSessionUrl"],
  ["exportConversation", "exportSession"],
] as const satisfies readonly (readonly [keyof Bridge, keyof Bridge])[];

export function sessionBridge(bridge: Bridge, sid: string): Bridge {
  const b = bridge;
  const scoped: Bridge = {
    ...b,
    sendOrQueueMessage: (id, text, opts) => b.sendSessionMessage(id, sid, text, opts),
    cancelTurn: async (id) => {
      try {
        await b.stopSession(id, sid);
      } catch (e) {
        // The project route answers a cancel of an idle conversation without an error; so does this one.
        if (!(e instanceof BridgeError && e.code === "not_running")) throw e;
      }
    },
  };
  // The project route → the session's route of the same call, with the session id after the project id.
  const extra: Record<string, unknown> = {};
  for (const [from, to] of SCOPED) {
    const f = b[to];
    if (f)
      extra[from] = (id: string, ...rest: unknown[]): unknown => {
        const out: unknown = Reflect.apply(f, b, [id, sid, ...rest]);
        return out;
      };
  }
  Object.assign(scoped, extra);
  const get = b.getSessionContext;
  // The report of a sub-agent (`agentId`) is the project route's; the session's own is its route.
  if (get) scoped.getContext = (id, agentId) => (agentId === undefined ? (get(id, sid) as Promise<ContextBreakdown>) : b.getContext(id, agentId));
  const approvals = b.listApprovals;
  if (approvals) scoped.listApprovals = (id) => approvals(id, { sessionId: sid });
  const inputs = b.listInputs;
  if (inputs) scoped.listInputs = (id) => inputs(id, { sessionId: sid });
  const clear = b.clearSession;
  if (clear)
    scoped.clearConversation = async (id) => {
      const made = await clear(id, sid);
      return {
        conversation_id: "",
        upto_message_id: 0,
        at: made.session.started_at,
        title: "",
        summary: made.session.summary ?? "",
        summary_source: "stored",
        session_id: made.session.id,
        previous_session_id: sid,
      };
    };
  return scoped;
}
