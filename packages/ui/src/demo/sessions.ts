import {
  BridgeError,
  type Agent,
  type Bridge,
  type MemoryExchange,
  type Message,
  type ProjectSession,
  type ProjectSessionState,
  type SessionsParams,
} from "@octo/agent-client";
import { emit, type ProjectRecord } from "./store";

const delay = () => new Promise((r) => setTimeout(r, 60));

/**
 * `?sessions=<code>` makes the matching operation fail the way the harness would (`turn_in_progress` on new / resume,
 * `current_session` on archive / delete, `session_running` on delete, `not_continuable` and `steer_unsupported` on a message,
 * `not_running` on stop); `?sessions=one` keeps only the current session.
 */
const knob = (): string | null => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("sessions"));

type Seed = {
  id: string;
  title: string;
  state: ProjectSessionState;
  hoursAgo: number;
  exchanges: number;
  model: string;
  archived?: boolean;
  /** Request / answer pairs: the session's conversation. */
  talk: [string, string][];
  agents?: SeedAgent[];
};
type SeedAgent = {
  id: string;
  title: string;
  state: ProjectSessionState;
  minutesIn: number;
  model: string;
  /** Why it cannot take a message (a code), or null when it can. */
  blocked: "steer_unsupported" | "not_continuable" | null;
  task: string;
  answer: string;
};

const SEEDS: Seed[] = [
  {
    id: "plan",
    title: "Plan the release",
    state: "idle",
    hoursAgo: 26,
    exchanges: 3,
    model: "claude-opus-5-5",
    talk: [
      [
        "Plan the release for Friday: what has to land first?",
        "Three things block Friday: the migration notes, the flaky upload test and the changelog. I would land them in that order.",
      ],
      ["Who owns the changelog?", "Nobody is named in the notes. I added it to the release checklist as unassigned."],
      ["Write the migration notes.", "Done: `docs/migrations/2026-11.md` lists the schema change, the rollback step and the two settings that moved."],
    ],
    agents: [
      {
        id: "plan-a1",
        title: "Collect the open pull requests",
        state: "idle",
        minutesIn: 4,
        model: "claude-haiku-4-5",
        blocked: null,
        task: "List the open pull requests that touch the release branch and say which ones are ready.",
        answer: "Seven pull requests touch the release branch; five are ready and two wait for review.",
      },
      {
        id: "plan-a2",
        title: "Check the migration against a copy",
        state: "idle",
        minutesIn: 9,
        model: "acp:claude-code",
        blocked: "not_continuable",
        task: "Run the schema migration against a copy of the database and report anything that fails.",
        answer: "The migration ran in 41 seconds on the copy; no failures.",
      },
      {
        id: "plan-a3",
        title: "Review the upload route for security",
        state: "working",
        minutesIn: 12,
        model: "acp:claude-code",
        blocked: "steer_unsupported",
        task: "Read the upload route and list anything that could let a client write outside the upload folder.",
        answer: "",
      },
      {
        id: "plan-a4",
        title: "Draft the changelog entries",
        state: "working",
        minutesIn: 15,
        model: "claude-haiku-4-5",
        blocked: null,
        task: "Write one changelog line for each merged pull request since the last release.",
        answer: "",
      },
    ],
  },
  {
    id: "flaky",
    title: "Fix the flaky upload test",
    state: "failed",
    hoursAgo: 52,
    exchanges: 2,
    model: "claude-sonnet-5-5",
    talk: [
      [
        "The upload test fails about one run in five. Find out why.",
        "The test races the temp-file cleanup: the file can vanish before the assertion reads it.",
      ],
      ["Fix it.", "The request failed before an answer: the model returned an error."],
    ],
    agents: [
      {
        id: "flaky-a1",
        title: "Reproduce the failure",
        state: "failed",
        minutesIn: 3,
        model: "claude-haiku-4-5",
        blocked: "not_continuable",
        task: "Run the upload test 50 times and record which runs fail.",
        answer: "",
      },
    ],
  },
  {
    id: "build",
    title: "Investigate the slow build",
    state: "stopped",
    hoursAgo: 80,
    exchanges: 1,
    model: "claude-sonnet-5-5",
    talk: [
      [
        "The build takes eleven minutes now. What changed?",
        "Stopped before it finished. What it had written so far: the dependency install doubled after the lockfile change.",
      ],
    ],
    agents: [
      {
        id: "build-a1",
        title: "Profile the build steps",
        state: "stopped",
        minutesIn: 2,
        model: "claude-haiku-4-5",
        blocked: null,
        task: "Time every step of the build and list the five slowest.",
        answer: "",
      },
    ],
  },
  {
    id: "waiting",
    title: "Draft the deploy checklist",
    state: "waiting",
    hoursAgo: 100,
    exchanges: 1,
    model: "claude-opus-5-5",
    talk: [["Draft the deploy checklist.", "I need your answer on one thing before I continue: should the checklist include the rollback drill?"]],
  },
  {
    id: "old",
    title: "Old spike: queue library",
    state: "idle",
    hoursAgo: 240,
    exchanges: 4,
    model: "claude-sonnet-5-5",
    archived: true,
    talk: [["Compare two queue libraries for the worker.", "Library A is smaller and has no retry policy; library B retries but pulls in a heavy dependency."]],
  },
];

type Main = { id: string; title: string; started_at: string; last_activity_at: string; exchanges: number; model: string; seed?: Seed };
type Entry = {
  mains: Main[];
  currentId: string;
  archived: Set<string>;
  titles: Map<string, string>;
  deleted: Set<string>;
  /** State of a seeded agent session after the person acted on it (stopped, continued). */
  agentState: Map<string, ProjectSessionState>;
  /** Messages the person sent to a seeded agent session. */
  agentTalk: Map<string, Message[]>;
  /** The orchestrator's requests (id, time): an agent session's `turn_id` is the newest request before it started. */
  turns: { id: number; at: string }[];
};

/** `turn_id` of an agent session: the newest request that came before it started (none when there is no such request). */
function turnOf(e: Entry, startedAt: string): { turn_id?: number } {
  const before = e.turns.filter((x) => x.at <= startedAt).at(-1);
  return before ? { turn_id: before.id } : {};
}

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

let messageId = 9000;
const say = (agent_id: string, role: "user" | "assistant", text: string, at: string, session_id?: string): Message => ({
  id: (messageId += 1),
  agent_id,
  role,
  content: [{ type: "text", text }],
  created_at: at,
  ...(session_id ? { session_id } : {}),
});

/**
 * Project sessions for the demo bridge. The orchestrator's conversation is the current main session; every sub-agent has an
 * agent session under it. Five more main sessions are seeded (idle, failed, stopped, waiting, archived) with agent sessions
 * that can and cannot take a message, and create / resume / patch / delete / stop / message work on a per-project list kept
 * here, with `session.*` events. `?sessions=` forces the error cases (see `knob`). The desktop demo replaces the main
 * sessions with the ones of its orchestrator memory (same ids as `listMemorySessions`).
 */
export function withDemoSessions(bridge: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const entries = new Map<string, Entry>();
  const orchestratorId = async (id: string): Promise<string> => (await bridge.listAgents(id)).find((a) => a.parent_id === null)?.id ?? "";
  const entryOf = async (id: string): Promise<Entry> => {
    let e = entries.get(id);
    if (!e) {
      const orch = await orchestratorId(id);
      const messages = orch ? await bridge.listMessages(id, orch) : [];
      const users = messages.filter((m) => m.role === "user" && textOf(m).trim() !== "");
      const first = users[0];
      const now = Date.now();
      const main: Main = {
        id: `ses_${id}_1`,
        title: first ? textOf(first).trim().split("\n")[0]?.slice(0, 80) || "New session" : "New session",
        started_at: first?.created_at ?? new Date(now).toISOString(),
        last_activity_at: messages.at(-1)?.created_at ?? new Date(now).toISOString(),
        exchanges: users.length,
        model: "claude-sonnet-5-5",
      };
      const seeded: Main[] =
        knob() === "one"
          ? []
          : SEEDS.map((s) => ({
              id: `ses_${id}_${s.id}`,
              title: s.title,
              started_at: new Date(now - s.hoursAgo * 3_600_000).toISOString(),
              last_activity_at: new Date(now - (s.hoursAgo - 1) * 3_600_000).toISOString(),
              exchanges: s.exchanges,
              model: s.model,
              seed: s,
            }));
      e = {
        mains: [main, ...seeded],
        currentId: main.id,
        archived: new Set(seeded.filter((m) => m.seed?.archived).map((m) => m.id)),
        titles: new Map(),
        deleted: new Set(),
        agentState: new Map(),
        agentTalk: new Map(),
        turns: users.map((m) => ({ id: m.id, at: m.created_at })),
      };
      entries.set(id, e);
    }
    return e;
  };
  const seedAgents = (e: Entry): { main: Main; agent: SeedAgent }[] => e.mains.flatMap((m) => (m.seed?.agents ?? []).map((agent) => ({ main: m, agent })));
  const snapshot = async (id: string): Promise<ProjectSession[]> => {
    const e = await entryOf(id);
    const agents = (await bridge.listAgents(id)).filter((a) => a.parent_id !== null);
    const orchestrating = records.get(id)?.turn != null;
    const live = e.mains.filter((m) => !e.deleted.has(m.id));
    const mains = live.map<ProjectSession>((m) => {
      const current = m.id === e.currentId;
      const state: ProjectSessionState = current ? (orchestrating ? "working" : "idle") : (m.seed?.state ?? "idle");
      return {
        id: m.id,
        kind: "main",
        title: e.titles.get(m.id) ?? m.title,
        state,
        model: m.model,
        started_at: m.started_at,
        last_activity_at: m.last_activity_at,
        exchanges: m.exchanges,
        children: current ? agents.length : (m.seed?.agents?.length ?? 0),
        current,
        archived: e.archived.has(m.id),
        can_message: current,
        ...(current ? {} : { message_blocked: { code: "not_current", message: "Resume this session to continue it" } }),
      };
    });
    const real = agents.map<ProjectSession>((a) => ({
      id: `ses_${a.id}`,
      kind: "agent",
      ...turnOf(e, a.created_at),
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
      can_message: a.status === "running" || a.status === "completed",
      ...(a.status === "running" || a.status === "completed"
        ? {}
        : { message_blocked: { code: "not_continuable", message: "This agent's conversation was not kept" } }),
    }));
    const seeded = seedAgents(e)
      .filter(({ main }) => !e.deleted.has(main.id))
      .map<ProjectSession>(({ main, agent }) => {
        const sid = `ses_${id}_${agent.id}`;
        const state = e.agentState.get(sid) ?? agent.state;
        const running = state === "working";
        const blocked = running ? (agent.blocked === "steer_unsupported" ? "steer_unsupported" : null) : agent.blocked;
        const at = new Date(Date.parse(main.started_at) + agent.minutesIn * 60_000).toISOString();
        return {
          id: sid,
          kind: "agent",
          parent_session_id: main.id,
          agent_id: agent.id,
          title: e.titles.get(sid) ?? agent.title,
          state,
          model: agent.model,
          started_at: at,
          last_activity_at: at,
          exchanges: 0,
          children: 0,
          current: false,
          archived: e.archived.has(sid) || e.archived.has(main.id),
          can_message: blocked === null,
          ...(blocked === null
            ? {}
            : {
                message_blocked: {
                  code: blocked,
                  message:
                    blocked === "steer_unsupported"
                      ? "This agent can't take a message while it works"
                      : "This agent can't be continued: its conversation was not kept",
                },
              }),
        };
      });
    return [...mains, ...real, ...seeded].sort((a, b) => b.started_at.localeCompare(a.started_at));
  };
  const find = async (id: string, sid: string): Promise<ProjectSession> => {
    const s = (await snapshot(id)).find((x) => x.id === sid);
    if (!s) throw new BridgeError(404, "not_found", `no session ${sid}`);
    return s;
  };
  const announce = async (id: string, sid: string) => {
    const rec = records.get(id);
    if (rec) emit(rec, { type: "session.updated", session: await find(id, sid) });
  };
  const fail = (codes: string[]) => {
    const k = knob();
    if (k !== null && codes.includes(k)) throw new BridgeError(409, k, `forced by ?sessions=${k}`);
  };
  const exchangesOf = (m: Main): MemoryExchange[] => {
    const talk = m.seed?.talk ?? [];
    return talk.map(([request, answer], i) => ({
      id: `${m.id}_x${i + 1}`,
      session_id: m.id,
      turn_id: i + 1,
      message_id: i + 2,
      request,
      answer,
      answer_truncated: false,
      status: m.seed?.state === "failed" && i === talk.length - 1 ? "failed" : m.seed?.state === "stopped" && i === talk.length - 1 ? "stopped" : "completed",
      started_at: new Date(Date.parse(m.started_at) + i * 600_000).toISOString(),
      duration_ms: 20_000,
      model: m.model,
      files: [],
      agents: [],
      tokens: { input: 2000, output: 400 },
      cost_usd: null,
    }));
  };
  const transcriptOf = async (id: string, sid: string) => {
    const e = await entryOf(id);
    const orch = await orchestratorId(id);
    const main = e.mains.find((m) => m.id === sid);
    if (main?.seed) {
      const t = Date.parse(main.started_at);
      const messages = main.seed.talk.flatMap(([q, a], i) => [
        say(orch, "user", q, new Date(t + i * 600_000).toISOString(), sid),
        say(orch, "assistant", a, new Date(t + i * 600_000 + 20_000).toISOString(), sid),
      ]);
      return { messages, compactions: [] };
    }
    if (main) return { messages: await bridge.listMessages(id, orch), compactions: [] };
    const seeded = seedAgents(e).find(({ agent }) => `ses_${id}_${agent.id}` === sid);
    if (seeded) {
      const t = Date.parse(seeded.main.started_at) + seeded.agent.minutesIn * 60_000;
      const base = [say(seeded.agent.id, "user", seeded.agent.task, new Date(t).toISOString())];
      if (seeded.agent.answer) base.push(say(seeded.agent.id, "assistant", seeded.agent.answer, new Date(t + 30_000).toISOString()));
      return { messages: [...base, ...(e.agentTalk.get(sid) ?? [])], compactions: [] };
    }
    const agentId = sid.replace(/^ses_/, "");
    return { messages: [...(await bridge.listMessages(id, agentId)), ...(e.agentTalk.get(sid) ?? [])], compactions: [] };
  };
  return {
    ...bridge,
    getTranscript: async (id, agentId, opts) => {
      if (opts?.sessionId) {
        const e = await entryOf(id);
        if (e.mains.some((m) => m.id === opts.sessionId && m.seed)) return transcriptOf(id, opts.sessionId);
      }
      return bridge.getTranscript(id, agentId, opts);
    },
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
      const e = await entryOf(id);
      const session = await find(id, sid);
      const main = e.mains.find((m) => m.id === sid);
      const children = (await snapshot(id)).filter((s) => s.parent_session_id === sid).sort((a, b) => a.started_at.localeCompare(b.started_at));
      const agent = session.agent_id ? (await bridge.listAgents(id)).find((a) => a.id === session.agent_id) : undefined;
      return { session, exchanges: main ? exchangesOf(main) : [], children, ...(agent ? { agent } : {}) };
    },
    getSessionTranscript: async (id, sid) => {
      await delay();
      await find(id, sid);
      return transcriptOf(id, sid);
    },
    createSession: async (id, title) => {
      await delay();
      fail(["turn_in_progress"]);
      const e = await entryOf(id);
      const rec = records.get(id);
      if (rec?.turn) throw new BridgeError(409, "turn_in_progress", "a turn is running");
      const now = new Date().toISOString();
      const previous = e.currentId;
      const main: Main = {
        id: `ses_${id}_n${e.mains.length + 1}`,
        title: title ?? "New session",
        started_at: now,
        last_activity_at: now,
        exchanges: 0,
        model: "claude-sonnet-5-5",
      };
      e.mains.push(main);
      e.currentId = main.id;
      const session = await find(id, main.id);
      if (rec) {
        emit(rec, { type: "session.created", session });
        emit(rec, { type: "session.current", session_id: main.id, previous_session_id: previous });
      }
      return session;
    },
    resumeSession: async (id, sid) => {
      await delay();
      fail(["turn_in_progress"]);
      const e = await entryOf(id);
      const rec = records.get(id);
      if (rec?.turn) throw new BridgeError(409, "turn_in_progress", "a turn is running");
      if (!e.mains.some((m) => m.id === sid)) throw new BridgeError(409, "not_main_session", "only a main session can be resumed");
      if (sid === e.currentId) return find(id, sid);
      const previous = e.currentId;
      e.currentId = sid;
      e.archived.delete(sid);
      if (rec) {
        emit(rec, { type: "session.updated", session: await find(id, previous) });
        emit(rec, { type: "session.updated", session: await find(id, sid) });
        emit(rec, { type: "session.current", session_id: sid, previous_session_id: previous });
      }
      return find(id, sid);
    },
    patchSession: async (id, sid, patch) => {
      await delay();
      const e = await entryOf(id);
      await find(id, sid);
      if (patch.archived === true) {
        fail(["current_session"]);
        if (sid === e.currentId) throw new BridgeError(409, "current_session", "the current session cannot be archived");
      }
      if (patch.title !== undefined) {
        if (patch.title.trim() === "") throw new BridgeError(400, "invalid_request", "a title cannot be empty");
        e.titles.set(sid, patch.title.trim());
      }
      if (patch.archived !== undefined) {
        if (patch.archived) e.archived.add(sid);
        else e.archived.delete(sid);
      }
      await announce(id, sid);
      return find(id, sid);
    },
    deleteSession: async (id, sid) => {
      await delay();
      fail(["current_session", "session_running"]);
      const e = await entryOf(id);
      const s = await find(id, sid);
      if (s.current) throw new BridgeError(409, "current_session", "the current session cannot be deleted");
      if (s.state === "working") throw new BridgeError(409, "session_running", "the session is running");
      const rec = records.get(id);
      const all = await snapshot(id);
      const gone = [sid, ...all.filter((x) => x.parent_session_id === sid).map((x) => x.id)];
      if (s.kind === "main") e.deleted.add(sid);
      else e.archived.add(sid);
      if (rec) for (const g of gone) emit(rec, { type: "session.updated", session_id: g, deleted: true });
    },
    stopSession: async (id, sid) => {
      await delay();
      fail(["not_running"]);
      const e = await entryOf(id);
      const s = await find(id, sid);
      if (s.state !== "working") throw new BridgeError(409, "not_running", "the session is not running");
      if (s.kind === "agent") e.agentState.set(sid, "stopped");
      else {
        const turn = records.get(id)?.turn;
        if (turn) turn.cancelled = true;
      }
      await announce(id, sid);
      return find(id, sid);
    },
    messageSession: async (id, sid, text, opts) => {
      await delay();
      fail(["not_continuable", "steer_unsupported"]);
      const e = await entryOf(id);
      const s = await find(id, sid);
      if (s.kind !== "agent") throw new BridgeError(409, "not_agent_session", "main session messages use the project's message route");
      if (!s.can_message) throw new BridgeError(409, s.message_blocked?.code ?? "not_continuable", s.message_blocked?.message ?? "cannot continue");
      const outcome = s.state === "working" ? "steered" : "continued";
      const at = new Date().toISOString();
      const list = e.agentTalk.get(sid) ?? [];
      e.agentTalk.set(sid, [...list, say(s.agent_id ?? sid, "user", text, at)]);
      if (outcome === "continued") e.agentState.set(sid, "working");
      void opts;
      await announce(id, sid);
      return { outcome, session: await find(id, sid) };
    },
  };
}
