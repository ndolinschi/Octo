import { BridgeError, type Agent, type Bridge, type Message, type ProjectSession, type ProjectSessionState, type SessionsParams } from "@octo/agent-client";
import { emit, type ProjectRecord } from "./store";

const delay = () => new Promise((r) => setTimeout(r, 60));

type Main = { id: string; title: string; started_at: string; last_activity_at: string; exchanges: number; summary?: string };
type Entry = { mains: Main[]; currentId: string; archived: Set<string>; titles: Map<string, string> };

const AGENT_STATE: Record<Agent["status"], ProjectSessionState> = {
  idle: "idle",
  running: "working",
  completed: "idle",
  failed: "failed",
  cancelled: "stopped",
};

function textOf(m: Message): string {
  return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
}

/**
 * Project sessions for the demo bridge, minimal but never empty: the orchestrator's conversation is one current main
 * session (titled by its first request), every sub-agent has an agent session under the current main one, and
 * create / resume / patch / delete work on a per-project list kept here. Events are not emitted, so state that reads
 * `state.sessions` shows what the list call returned. The desktop demo replaces the main sessions with the ones of its
 * orchestrator memory (same ids as `listMemorySessions`).
 */
export function withDemoSessions(bridge: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const entries = new Map<string, Entry>();
  const entryOf = async (id: string): Promise<Entry> => {
    let e = entries.get(id);
    if (!e) {
      const agents = await bridge.listAgents(id);
      const orch = agents.find((a) => a.parent_id === null);
      const messages = orch ? await bridge.listMessages(id, orch.id) : [];
      const users = messages.filter((m) => m.role === "user" && textOf(m).trim() !== "");
      const first = users[0];
      const now = new Date().toISOString();
      const main: Main = {
        id: `ses_${id}_1`,
        title: first ? textOf(first).trim().split("\n")[0]?.slice(0, 80) || "New session" : "New session",
        started_at: first?.created_at ?? now,
        last_activity_at: messages.at(-1)?.created_at ?? now,
        exchanges: users.length,
      };
      e = { mains: [main], currentId: main.id, archived: new Set(), titles: new Map() };
      entries.set(id, e);
    }
    return e;
  };
  const snapshot = async (id: string): Promise<ProjectSession[]> => {
    const e = await entryOf(id);
    const agents = (await bridge.listAgents(id)).filter((a) => a.parent_id !== null);
    const mains = e.mains.map<ProjectSession>((m) => ({
      id: m.id,
      kind: "main",
      title: e.titles.get(m.id) ?? m.title,
      state: "idle",
      model: "",
      started_at: m.started_at,
      last_activity_at: m.last_activity_at,
      exchanges: m.exchanges,
      children: m.id === e.currentId ? agents.length : 0,
      current: m.id === e.currentId,
      archived: e.archived.has(m.id),
      ...(m.summary ? { summary: m.summary } : {}),
      can_message: m.id === e.currentId,
      ...(m.id === e.currentId ? {} : { message_blocked: { code: "not_current", message: "Resume this session to continue it" } }),
    }));
    const children = agents.map<ProjectSession>((a) => ({
      id: `ses_${a.id}`,
      kind: "agent",
      parent_session_id: e.currentId,
      agent_id: a.id,
      title: e.titles.get(`ses_${a.id}`) ?? (a.title || a.role),
      state: AGENT_STATE[a.status],
      model: a.model,
      started_at: a.started_at ?? a.created_at,
      last_activity_at: a.finished_at ?? a.started_at ?? a.created_at,
      exchanges: 0,
      children: 0,
      current: false,
      archived: e.archived.has(`ses_${a.id}`),
      can_message: a.status === "running",
      ...(a.status === "running" ? {} : { message_blocked: { code: "not_running", message: "This agent has finished" } }),
    }));
    // The current main session works while the orchestrator does.
    const orchestrating = records.get(id)?.turn != null;
    return [...mains.map((s) => (s.current && orchestrating ? { ...s, state: "working" as const } : s)), ...children].sort((a, b) =>
      b.started_at.localeCompare(a.started_at),
    );
  };
  const find = async (id: string, sid: string): Promise<ProjectSession> => {
    const s = (await snapshot(id)).find((x) => x.id === sid);
    if (!s) throw new BridgeError(404, "not_found", `no session ${sid}`);
    return s;
  };
  const announce = (id: string, session: ProjectSession) => {
    const rec = records.get(id);
    if (rec) emit(rec, { type: "session.updated", session });
  };
  return {
    ...bridge,
    listSessions: async (id, params?: SessionsParams) => {
      await delay();
      const all = await snapshot(id);
      const archived = params?.archived ?? false;
      return all
        .filter((s) => (params?.kind ? s.kind === params.kind : true) && (params?.state ? s.state === params.state : true))
        .filter((s) => archived === "all" || s.archived === archived)
        .filter((s) => (params?.before ? s.started_at < params.before : true))
        .slice(0, params?.limit ?? 50);
    },
    getSession: async (id, sid) => {
      await delay();
      const session = await find(id, sid);
      const children = (await snapshot(id)).filter((s) => s.parent_session_id === sid);
      return { session, exchanges: [], children };
    },
    createSession: async (id, title) => {
      await delay();
      const e = await entryOf(id);
      const now = new Date().toISOString();
      const main: Main = { id: `ses_${id}_${e.mains.length + 1}`, title: title ?? "New session", started_at: now, last_activity_at: now, exchanges: 0 };
      e.mains.push(main);
      e.currentId = main.id;
      return find(id, main.id);
    },
    resumeSession: async (id, sid) => {
      await delay();
      const e = await entryOf(id);
      if (!e.mains.some((m) => m.id === sid)) throw new BridgeError(409, "not_main_session", "only a main session can be resumed");
      e.currentId = sid;
      e.archived.delete(sid);
      return find(id, sid);
    },
    patchSession: async (id, sid, patch) => {
      await delay();
      const e = await entryOf(id);
      await find(id, sid);
      if (patch.archived === true && sid === e.currentId) throw new BridgeError(409, "current_session", "the current session cannot be archived");
      if (patch.title !== undefined) {
        if (patch.title.trim() === "") throw new BridgeError(400, "invalid_request", "a title cannot be empty");
        e.titles.set(sid, patch.title.trim());
      }
      if (patch.archived !== undefined) {
        if (patch.archived) e.archived.add(sid);
        else e.archived.delete(sid);
      }
      const session = await find(id, sid);
      announce(id, session);
      return session;
    },
  };
}
