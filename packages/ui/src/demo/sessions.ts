import {
  BridgeError,
  type Agent,
  type Approval,
  type Bridge,
  type CreatedSession,
  type DeleteAllSessionsResult,
  type GlobalSession,
  type ImportableSession,
  type ImportSessionRef,
  type ImportSessionsResult,
  type MemoryExchange,
  type Message,
  type MoveToWorktreeInput,
  type MoveToWorktreeResult,
  type NewSessionInput,
  type ProjectSession,
  type ProjectSessionState,
  type QueuedMessage,
  type SendResult,
  type SessionsParams,
  type Workspace,
} from "@octo/agent-client";
import { addRoot, addTalk, announceRoot, startIn, SYNC_PROMPT, syncRefactor } from "./parallel";
import { clone, emit, newId, type ProjectRecord } from "./store";
import { titleFromRequest } from "../lib/sessions/title";

const delay = () => new Promise((r) => setTimeout(r, 60));

/**
 * `?sessions=<code>` makes the matching operation fail the way the harness would (`turn_in_progress` on new / resume,
 * `current_session` on archive / delete, `session_running` on delete, `not_continuable` and `steer_unsupported` on a message,
 * `not_running` on stop); `?sessions=one` keeps only the default session.
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
    hoursAgo: 29,
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
      // R2: no answer text: the error notice under the request says why (the harness writes no reply for it).
      ["Fix it.", ""],
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

type Main = {
  id: string;
  title: string;
  started_at: string;
  last_activity_at: string;
  model: string;
  root: string;
  seed?: Seed;
  workspace?: ProjectSession["workspace"];
  /** Its own queue (the default session's is the project's, in `v7.ts`). */
  queue: (QueuedMessage & { waiting_for: "turn" | "slot" })[];
  paused: boolean;
  /** Approvals asked in this session (the seeded "waiting" one). */
  approvals: Approval[];
};
type Entry = {
  mains: Main[];
  archived: Set<string>;
  titles: Map<string, string>;
  deleted: Set<string>;
  workspaces: Workspace[];
  /** State of a seeded agent session after the person acted on it (stopped, continued). */
  agentState: Map<string, ProjectSessionState>;
  /** Messages the person sent to a seeded agent session. */
  agentTalk: Map<string, Message[]>;
};

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
const say = (agent_id: string, role: "user" | "assistant", text: string, at: string): Message => ({
  id: (messageId += 1),
  agent_id,
  role,
  content: [{ type: "text", text }],
  created_at: at,
});

const MAX_RUNNING = 3;

/**
 * Parallel sessions for the demo bridge (spec 2026-11-14, section 8). Every main session has its own root agent and
 * conversation; one is the default (the project's orchestrator row, what the project routes act on). Atlas has five more main
 * sessions (idle, failed, stopped, waiting for an approval, archived) with agent sessions that can
 * and cannot take a message. Orbit also runs a second session next to its default one and has a third waiting for a free
 * slot (its `max_running` is 2). Sessions can be created, made default, renamed, archived, deleted, stopped and messaged;
 * a busy session queues, a full project waits for a slot. `?sessions=` forces the error cases (see `knob`).
 */
export function withDemoSessions(bridge: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const entries = new Map<string, Entry>();

  const recOf = (id: string): ProjectRecord => {
    const rec = records.get(id);
    if (!rec) throw new BridgeError(404, "not_found", "project not found");
    return rec;
  };
  const maxRunning = (rec: ProjectRecord) => rec.project.session_settings?.max_running ?? MAX_RUNNING;
  const running = (rec: ProjectRecord, m: Main) => rec.turns?.has(m.root) ?? false;
  const isDefault = (rec: ProjectRecord, m: Main) => m.root === rec.project.orchestrator_agent_id;

  const init = (rec: ProjectRecord): Entry => {
    const id = rec.project.id;
    const orch = rec.agents.find((a) => a.id === rec.project.orchestrator_agent_id);
    const now = Date.now();
    const first: Main = {
      id: `ses_${id}_1`,
      title: "",
      started_at: rec.project.created_at,
      last_activity_at: rec.project.updated_at,
      model: orch?.model ?? "claude-sonnet-5-5",
      root: rec.project.orchestrator_agent_id,
      queue: [],
      paused: false,
      approvals: [],
    };
    if (orch) orch.session_id = first.id;
    // The seeded sessions belong to Atlas (the showcase project); every other project starts with its default session alone.
    const seeded: Main[] = (knob() === "one" || !rec.project.name.startsWith("Atlas") ? [] : SEEDS).map((s) => {
      const sid = `ses_${id}_${s.id}`;
      const started = now - s.hoursAgo * 3_600_000;
      const at = new Date(started).toISOString();
      const root = addRoot(rec, sid, at, s.model, s.state === "failed" ? "failed" : "idle");
      addTalk(rec, root.id, s.talk, started);
      if (s.state === "failed" || s.state === "stopped") (rec.lastStatus ??= new Map()).set(root.id, s.state === "failed" ? "failed" : "cancelled");
      const approvals: Approval[] =
        s.state === "waiting"
          ? [
              {
                id: newId("apr"),
                agent_id: root.id,
                session_id: sid,
                agent_label: "orchestrator",
                turn_id: rec.nextMessageId - 2,
                kind: "command",
                title: "git push origin release/checklist",
                detail: { command: "git push origin release/checklist" },
                created_at: new Date(started + 30_000).toISOString(),
              },
            ]
          : [];
      return {
        id: sid,
        title: s.title,
        started_at: at,
        last_activity_at: new Date(started + (s.talk.length - 1) * 600_000 + 20_000).toISOString(),
        model: s.model,
        root: root.id,
        seed: s,
        queue: [],
        paused: false,
        approvals,
      };
    });
    const sharedWorkspace: Workspace = {
      id: "shared",
      kind: "shared",
      title: "Main checkout",
      state: "ready",
      created_at: rec.project.created_at,
      folders: rec.project.folders.map((f) => ({
        workspace_id: "shared",
        folder_id: f.id,
        folder_label: f.label,
        path: f.path,
        shared: true,
      })),
    };
    const e: Entry = {
      mains: [first, ...seeded],
      archived: new Set(seeded.filter((m) => m.seed?.archived).map((m) => m.id)),
      titles: new Map(),
      deleted: new Set(),
      workspaces: [sharedWorkspace],
      agentState: new Map(),
      agentTalk: new Map(),
    };
    if (rec.project.name.startsWith("Orbit") && knob() !== "one") {
      // Two sessions of one project at work, and a third waiting for a free slot (`max_running` 2).
      rec.project.session_settings = { max_running: 2, default_workspace: "shared", coordination: "workspace" };
      const at = new Date(now - 4_000).toISOString();
      const sync: Main = {
        id: `ses_${id}_sync`,
        title: "Refactor the offline sync queue",
        started_at: at,
        last_activity_at: at,
        model: "claude-sonnet-5-5",
        root: addRoot(rec, `ses_${id}_sync`, at, "claude-sonnet-5-5").id,
        queue: [],
        paused: false,
        approvals: [],
      };
      const docsAt = new Date(now - 2_000).toISOString();
      const docs: Main = {
        id: `ses_${id}_docs`,
        title: "Update the API docs for 0.80",
        started_at: docsAt,
        last_activity_at: docsAt,
        model: "claude-haiku-5-5",
        root: addRoot(rec, `ses_${id}_docs`, docsAt, "claude-haiku-5-5").id,
        queue: [
          { id: newId("q"), text: "Update the API docs for React Native 0.80: list what changed for app code.", created_at: docsAt, waiting_for: "slot" },
        ],
        paused: false,
        approvals: [],
      };
      e.mains.push(sync, docs);
      startIn(rec, sync.root, (ctx) => syncRefactor(ctx, SYNC_PROMPT));
    }
    entries.set(id, e);
    rec.afterTurn = (rootId) => void afterTurn(rec, rootId);
    // A root agent's state is its session's: every change of it is a `session.updated`, as the harness sends.
    rec.listeners.add({
      onEvent: (ev) => {
        if (ev.type !== "agent.updated" || ev.agent.parent_id !== null) return;
        const m = e.mains.find((x) => x.root === ev.agent.id);
        if (m) void announce(id, m.id);
      },
    });
    return e;
  };
  for (const rec of records.values()) init(rec);

  const entryOf = (id: string): Entry => {
    const e = entries.get(id);
    if (e) return e;
    return init(recOf(id));
  };
  const mainOf = (id: string, sid: string): Main | undefined => entryOf(id).mains.find((m) => m.id === sid && !entryOf(id).deleted.has(sid));
  const defaultOf = (id: string): Main => {
    const rec = recOf(id);
    const e = entryOf(id);
    return e.mains.find((m) => isDefault(rec, m)) ?? (e.mains[0] as Main);
  };

  /** The session a sub-agent works in: the session of its root. */
  const rootSession = (rec: ProjectRecord, e: Entry, agent: Agent): Main | undefined => {
    let a: Agent | undefined = agent;
    const seen = new Set<string>();
    while (a?.parent_id && !seen.has(a.id)) {
      seen.add(a.id);
      const parent: string = a.parent_id;
      a = rec.agents.find((x) => x.id === parent);
    }
    return a ? e.mains.find((m) => m.root === a.id) : undefined;
  };

  const mainState = (rec: ProjectRecord, m: Main, approvals: number): ProjectSessionState => {
    if (running(rec, m)) return approvals > 0 ? "waiting" : "working";
    if (m.queue.some((q) => q.waiting_for === "slot")) return "queued";
    if (approvals > 0) return "waiting";
    const last = rec.lastStatus?.get(m.root);
    if (last === "failed" || rec.agents.find((a) => a.id === m.root)?.status === "failed") return "failed";
    if (last === "cancelled") return "stopped";
    if (last === "completed") return "idle";
    return m.seed?.state ?? "idle";
  };

  const titleOf = (rec: ProjectRecord, e: Entry, m: Main): string => {
    const own = e.titles.get(m.id) ?? m.title;
    if (own) return own;
    const first = rec.messages.find((x) => x.agent_id === m.root && x.role === "user" && x.command === undefined && textOf(x).trim() !== "");
    return first ? titleFromRequest(textOf(first)) : "New session";
  };

  const mainSession = async (id: string, m: Main): Promise<ProjectSession> => {
    const rec = recOf(id);
    const e = entryOf(id);
    const def = isDefault(rec, m);
    const base = def && bridge.listApprovals ? (await bridge.listApprovals(id)).filter((a) => !a.session_id) : [];
    const approvals = m.approvals.length + base.length;
    const own = rec.messages.filter((x) => x.agent_id === m.root);
    const users = own.filter((x) => x.role === "user" && x.command === undefined && textOf(x).trim() !== "").length;
    const subAgents = rec.agents.filter((a) => a.parent_id !== null && rootSession(rec, e, a)?.id === m.id).length;
    return {
      id: m.id,
      kind: "main",
      title: titleOf(rec, e, m),
      state: mainState(rec, m, approvals),
      model: m.model,
      // A session without a seed began with its first request (the project's history plays in after the seed).
      started_at: (m.seed ? undefined : own[0]?.created_at) ?? m.started_at,
      last_activity_at: own.at(-1)?.created_at ?? m.last_activity_at,
      exchanges: users,
      children: subAgents + (m.seed?.agents?.length ?? 0),
      current: def,
      default: def,
      archived: e.archived.has(m.id),
      root_agent_id: m.root,
      workspace: m.workspace ?? { id: "shared", kind: "shared", title: "Main checkout" },
      memory: "on",
      memory_inherited: true,
      mode: "",
      queued: def ? 0 : m.queue.length,
      queue_paused: m.paused,
      needs_you: approvals > 0,
      pending_approvals: approvals,
      pending_inputs: 0,
      can_message: true,
    };
  };

  const seedAgents = (id: string, e: Entry): { main: Main; agent: SeedAgent }[] =>
    e.mains
      .filter((m) => !e.deleted.has(m.id))
      .flatMap((m) => (m.seed?.agents ?? []).filter((agent) => !e.deleted.has(`ses_${id}_${agent.id}`)).map((agent) => ({ main: m, agent })));

  const snapshot = async (id: string): Promise<ProjectSession[]> => {
    const rec = recOf(id);
    const e = entryOf(id);
    const live = e.mains.filter((m) => !e.deleted.has(m.id));
    const mains = await Promise.all(live.map((m) => mainSession(id, m)));
    const real = rec.agents
      .filter((a) => a.parent_id !== null && !e.deleted.has(`ses_${a.id}`))
      .map<ProjectSession>((a) => {
        const owner = rootSession(rec, e, a);
        const request = owner ? rec.messages.filter((m) => m.agent_id === owner.root && m.role === "user" && m.created_at <= a.created_at).at(-1) : undefined;
        return {
          id: `ses_${a.id}`,
          kind: "agent",
          ...(request ? { turn_id: request.id } : {}),
          ...(owner ? { parent_session_id: owner.id } : {}),
          agent_id: a.id,
          title: e.titles.get(`ses_${a.id}`) ?? (a.title || a.role),
          state: AGENT_STATE[a.status],
          model: a.model,
          started_at: a.started_at ?? a.created_at,
          last_activity_at: a.finished_at ?? a.started_at ?? a.created_at,
          exchanges: 0,
          children: 0,
          current: false,
          default: false,
          archived: e.archived.has(`ses_${a.id}`),
          can_message: a.status === "running" || a.status === "completed",
          ...(a.status === "running" || a.status === "completed"
            ? {}
            : { message_blocked: { code: "not_continuable", message: "This agent's conversation was not kept" } }),
        };
      });
    const seeded = seedAgents(id, e).map<ProjectSession>(({ main, agent }) => {
      const sid = `ses_${id}_${agent.id}`;
      const state = e.agentState.get(sid) ?? agent.state;
      const busy = state === "working";
      const blocked = busy ? (agent.blocked === "steer_unsupported" ? "steer_unsupported" : null) : agent.blocked;
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
        default: false,
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
  async function announce(id: string, sid: string): Promise<void> {
    const rec = records.get(id);
    if (!rec) return;
    const s = (await snapshot(id)).find((x) => x.id === sid);
    if (s) emit(rec, { type: "session.updated", session: s, ...(s.kind === "main" ? { session_id: s.id } : {}) });
  }
  const fail = (codes: string[]) => {
    const k = knob();
    if (k !== null && codes.includes(k)) throw new BridgeError(409, k, `forced by ?sessions=${k}`);
  };
  const queueEvent = (rec: ProjectRecord, m: Main) => emit(rec, { type: "queue.updated", session_id: m.id, paused: m.paused, messages: clone(m.queue) });

  /** Starts a turn in non-default session `m` (the base bridge runs the script on its root). */
  const start = async (id: string, m: Main, text: string): Promise<SendResult> => {
    const sent = await bridge.sendSessionMessage(id, m.id, text);
    m.last_activity_at = new Date().toISOString();
    return sent;
  };

  /** A turn of root `rootId` ended: its own queue goes on, then the oldest message waiting for a slot in the project starts. */
  async function afterTurn(rec: ProjectRecord, rootId: string): Promise<void> {
    const id = rec.project.id;
    const e = entryOf(id);
    const done = e.mains.find((m) => m.root === rootId);
    const free = () => (rec.turns?.size ?? 0) < maxRunning(rec);
    if (done && !isDefault(rec, done) && !done.paused && done.queue[0] && free()) {
      const next = done.queue.shift();
      queueEvent(rec, done);
      if (next) await start(id, done, next.text).catch(() => undefined);
    }
    const waiting = e.mains
      .filter((m) => !e.deleted.has(m.id) && !running(rec, m))
      .flatMap((m) => m.queue.filter((q) => q.waiting_for === "slot").map((q) => ({ m, q })))
      .sort((a, b) => a.q.created_at.localeCompare(b.q.created_at))[0];
    if (waiting && free()) {
      waiting.m.queue = waiting.m.queue.filter((q) => q !== waiting.q);
      queueEvent(rec, waiting.m);
      await start(id, waiting.m, waiting.q.text).catch(() => undefined);
    }
    if (done) await announce(id, done.id);
  }

  const sendTo = async (id: string, sid: string, text: string, opts?: Parameters<Bridge["sendSessionMessage"]>[3]): Promise<SendResult> => {
    await delay();
    const rec = recOf(id);
    const e = entryOf(id);
    const m = mainOf(id, sid);
    if (!m) throw new BridgeError(404, "not_found", `no session ${sid}`);
    if (e.archived.delete(sid)) await announce(id, sid);
    // The default session is the project's conversation: the project route (with its queue, modes and triggers).
    if (isDefault(rec, m)) {
      if (bridge.sendOrQueueMessage) return bridge.sendOrQueueMessage(id, text, opts);
      return { message: await bridge.sendMessage(id, text) };
    }
    const wait = running(rec, m) ? "turn" : (rec.turns?.size ?? 0) >= maxRunning(rec) ? "slot" : null;
    if (wait) {
      if (m.queue.length >= 20) throw new BridgeError(409, "queue_full", "This session already has 20 messages waiting.");
      const q = { id: newId("q"), text, created_at: new Date().toISOString(), session_id: sid, waiting_for: wait } as const;
      m.queue.push({ ...q });
      queueEvent(rec, m);
      await announce(id, sid);
      return { queued: clone(q), waiting_for: wait };
    }
    return start(id, m, text);
  };

  const createIn = async (id: string, input: NewSessionInput = {}): Promise<CreatedSession> => {
    await delay();
    const rec = recOf(id);
    const e = entryOf(id);
    const from = input.clear ? (input.from_session_id ? mainOf(id, input.from_session_id) : defaultOf(id)) : undefined;
    if (input.clear) {
      fail(["turn_in_progress"]);
      if (!from) throw new BridgeError(404, "not_found", "no such session");
      if (running(rec, from)) throw new BridgeError(409, "turn_in_progress", "a turn is running");
    }
    const now = new Date().toISOString();
    const sid = `ses_${id}_n${e.mains.length + 1}`;
    const root = addRoot(rec, sid, now, from?.model ?? "claude-sonnet-5-5");
    const main: Main = {
      id: sid,
      title: input.title?.trim() ?? "",
      started_at: now,
      last_activity_at: now,
      model: root.model,
      root: root.id,
      queue: [],
      paused: false,
      approvals: [],
    };
    e.mains.push(main);
    announceRoot(rec, root);
    emit(rec, { type: "session.created", session: await mainSession(id, main), session_id: sid });
    if (input.make_default || (from && isDefault(rec, from))) await makeDefault(id, sid);
    const out: CreatedSession = { session: await mainSession(id, main) };
    if (input.text) {
      const sent = await sendTo(id, sid, input.text, input.mode ? { mode: input.mode } : undefined);
      if (sent.message) out.message = sent.message;
      if (sent.queued) out.queued = sent.queued;
    }
    return out;
  };

  async function makeDefault(id: string, sid: string): Promise<ProjectSession> {
    const rec = recOf(id);
    const e = entryOf(id);
    const m = mainOf(id, sid);
    if (!m) throw new BridgeError(409, "not_main_session", "only a main session can be the default");
    const previous = defaultOf(id);
    if (previous.id === sid) return mainSession(id, m);
    e.archived.delete(sid);
    rec.project.orchestrator_agent_id = m.root;
    rec.turn = rec.turns?.get(m.root) ?? null;
    emit(rec, { type: "session.default", session_id: sid, previous_session_id: previous.id });
    emit(rec, { type: "session.current", session_id: sid, previous_session_id: previous.id });
    emit(rec, { type: "project.updated", project: clone(rec.project) });
    await announce(id, previous.id);
    await announce(id, sid);
    return mainSession(id, m);
  }

  const sessionQueue = (id: string, sid: string): Main => {
    const m = mainOf(id, sid);
    if (!m) throw new BridgeError(404, "not_found", `no session ${sid}`);
    return m;
  };
  const isDefaultId = (id: string, sid: string) => defaultOf(id).id === sid;

  const allApprovals = async (id: string): Promise<Approval[]> => {
    const base = bridge.listApprovals ? await bridge.listApprovals(id) : [];
    const e = entryOf(id);
    return [...base, ...e.mains.filter((m) => !e.deleted.has(m.id)).flatMap((m) => clone(m.approvals))];
  };
  const inSession = (id: string, sid: string | undefined) => (a: { session_id?: string }) =>
    sid === undefined ? true : a.session_id ? a.session_id === sid : isDefaultId(id, sid);

  /**
   * A seeded session's exchanges, on its own messages (`turn_id` and `message_id` are the ids of its request and answer, so
   * the conversation finds each request's stored ending); the last one ends as the session did, with the harness's fields.
   */
  const exchangesOf = (id: string, m: Main): MemoryExchange[] => {
    const talk = m.seed?.talk ?? [];
    const own = (records.get(id)?.messages ?? []).filter((x) => x.agent_id === m.root);
    const asked = own.filter((x) => x.role === "user");
    return talk.map(([request, answer], i): MemoryExchange => {
      const prompt = asked[i];
      const reply = own.find((x) => x.role === "assistant" && prompt !== undefined && x.id > prompt.id);
      const last = i === talk.length - 1;
      const status = last && m.seed?.state === "failed" ? "failed" : last && m.seed?.state === "stopped" ? "stopped" : "completed";
      return {
        id: `${m.id}_x${i + 1}`,
        session_id: m.id,
        turn_id: prompt?.id ?? 0,
        message_id: reply?.id ?? 0,
        request,
        answer,
        answer_truncated: false,
        status,
        started_at: prompt?.created_at ?? new Date(Date.parse(m.started_at) + i * 600_000).toISOString(),
        duration_ms: 20_000,
        model: m.model,
        files: [],
        agents: [],
        tokens: { input: 2000, output: 400 },
        cost_usd: null,
        // The same failure as the session's root agent row (`parallel.ts`), as the harness stores it.
        ...(status === "failed" ? { error: { code: "agent_failed", message: "The model returned an error." } } : {}),
        ...(status !== "completed" ? { kept_text: reply !== undefined } : {}),
      };
    });
  };
  const defaultExchanges = (id: string, m: Main): MemoryExchange[] =>
    (records.get(id)?.endings ?? []).map((x, i) => ({
      id: `${m.id}_r${i + 1}`,
      session_id: m.id,
      turn_id: x.turn_id,
      message_id: 0,
      request: "",
      answer: "",
      answer_truncated: false,
      status: x.status,
      started_at: x.started_at,
      duration_ms: x.duration_ms,
      model: m.model,
      files: [],
      agents: [],
      tokens: { input: 0, output: 0 },
      cost_usd: null,
      ...(x.error ? { error: x.error } : {}),
      ...(x.interrupted ? { interrupted: true } : {}),
      ...(x.kept_text === undefined ? {} : { kept_text: x.kept_text }),
    }));

  const agentTranscript = async (id: string, sid: string) => {
    const e = entryOf(id);
    const seeded = seedAgents(id, e).find(({ agent }) => `ses_${id}_${agent.id}` === sid);
    if (seeded) {
      const t = Date.parse(seeded.main.started_at) + seeded.agent.minutesIn * 60_000;
      const base = [say(seeded.agent.id, "user", seeded.agent.task, new Date(t).toISOString())];
      if (seeded.agent.answer) base.push(say(seeded.agent.id, "assistant", seeded.agent.answer, new Date(t + 30_000).toISOString()));
      return { messages: [...base, ...(e.agentTalk.get(sid) ?? [])], compactions: [] };
    }
    const agentId = sid.replace(/^ses_/, "");
    return { messages: [...(await bridge.listMessages(id, agentId)), ...(e.agentTalk.get(sid) ?? [])], compactions: [] };
  };

  type ImportSeed = {
    provider: string;
    provider_label: string;
    id: string;
    title: string;
    cwd: string;
    model: string;
    hoursAgo: number;
    talk: [string, string][];
  };
  const IMPORT_SEEDS: ImportSeed[] = [
    {
      provider: "claude_code",
      provider_label: "Claude Code",
      id: "claude-jwt-audit",
      title: "Audit JWT refresh cookie flags",
      cwd: "/Users/maya/code/atlas-api",
      model: "claude-sonnet-5-5",
      hoursAgo: 18,
      talk: [
        [
          "Check how refresh cookies are set in atlas-api auth routes.",
          "Checked `src/auth/login.ts` and `src/auth/refresh.ts`: `httpOnly` and `sameSite: 'lax'` are set, while `secure` is gated on `NODE_ENV === 'production'`.",
        ],
        [
          "Add SameSite=Strict for the refresh endpoint.",
          "Updated `setRefreshCookie` in `src/auth/cookies.ts` to use `sameSite: 'strict'` and verified the auth cookie tests pass.",
        ],
      ],
    },
    {
      provider: "codex",
      provider_label: "Codex CLI",
      id: "codex-search-debounce",
      title: "Debounce project search input",
      cwd: "/Users/maya/code/atlas-web",
      model: "gpt-5-codex",
      hoursAgo: 42,
      talk: [
        [
          "Search re-queries on every keystroke and flickers when fast typing.",
          "Added a 150ms debounce and cancelled stale abort controllers in `useSearchQuery.ts`.",
        ],
      ],
    },
    {
      provider: "gemini",
      provider_label: "Gemini CLI",
      id: "gemini-scroll-restore",
      title: "Fix flatlist scroll restoration",
      cwd: "/Users/maya/code/orbit-app",
      model: "gemini-2.5-pro",
      hoursAgo: 65,
      talk: [
        [
          "Feed jumps back to top after returning from an issue detail screen.",
          "Memoized `maintainVisibleContentPosition` key extraction and preserved scroll offset in navigation params.",
        ],
      ],
    },
    {
      provider: "opencode",
      provider_label: "OpenCode",
      id: "opencode-changelog-gen",
      title: "Add API changelog script",
      cwd: "/Users/maya/code/docs-site",
      model: "claude-haiku-5-5",
      hoursAgo: 96,
      talk: [
        ["Generate markdown changelog notes from tagged OpenAPI specs.", "Added `scripts/diff-openapi.ts` and wired `pnpm changelog:api` in `package.json`."],
      ],
    },
  ];
  const importedByProject = new Map<string, Set<string>>();
  const matchProject = (cwd: string): ProjectRecord | undefined => {
    let best: { rec: ProjectRecord; len: number } | undefined;
    for (const rec of records.values()) {
      for (const f of rec.project.folders) {
        if (cwd === f.path || cwd.startsWith(`${f.path}/`)) {
          if (!best || f.path.length > best.len) best = { rec, len: f.path.length };
        }
      }
    }
    return best?.rec;
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
    listAllSessions: async (params) => {
      await delay();
      const out: GlobalSession[] = [];
      for (const rec of records.values()) {
        const id = rec.project.id;
        for (const s of await snapshot(id)) if (s.kind === "main") out.push({ ...s, project_id: id, project_name: rec.project.name });
      }
      const archived = params?.archived ?? false;
      return out
        .filter((s) => (params?.state ? s.state === params.state : true) && (archived === "all" || s.archived === archived))
        .filter((s) => (params?.before ? s.last_activity_at < params.before : true))
        .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
        .slice(0, params?.limit ?? 100);
    },
    getSession: async (id, sid) => {
      await delay();
      const rec = recOf(id);
      const session = await find(id, sid);
      const m = mainOf(id, sid);
      const children = (await snapshot(id)).filter((s) => s.parent_session_id === sid).sort((a, b) => a.started_at.localeCompare(b.started_at));
      const agent = session.agent_id ? (await bridge.listAgents(id)).find((a) => a.id === session.agent_id) : undefined;
      const exchanges = m ? (isDefault(rec, m) ? defaultExchanges(id, m) : exchangesOf(id, m)) : [];
      return { session, exchanges, children, ...(agent ? { agent } : {}) };
    },
    getSessionTranscript: async (id, sid) => {
      await delay();
      await find(id, sid);
      const m = mainOf(id, sid);
      return m ? bridge.getTranscript(id, m.root) : agentTranscript(id, sid);
    },
    createSession: (id, input) => createIn(id, input),
    clearSession: (id, sid) => createIn(id, { from_session_id: sid, clear: true }),
    setDefaultSession: async (id, sid) => {
      await delay();
      return makeDefault(id, sid);
    },
    resumeSession: async (id, sid) => {
      await delay();
      fail(["turn_in_progress"]);
      return makeDefault(id, sid);
    },
    patchSession: async (id, sid, patch) => {
      await delay();
      const e = entryOf(id);
      await find(id, sid);
      if (patch.archived === true) {
        fail(["current_session"]);
        if (isDefaultId(id, sid)) throw new BridgeError(409, "current_session", "the default session cannot be archived");
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
      const rec = recOf(id);
      const e = entryOf(id);
      const s = await find(id, sid);
      if (s.kind === "main" && isDefaultId(id, sid)) throw new BridgeError(409, "current_session", "the default session cannot be deleted");
      if (s.state === "working" || s.state === "waiting") throw new BridgeError(409, "session_running", "the session is running");
      const gone = [sid, ...(await snapshot(id)).filter((x) => x.parent_session_id === sid).map((x) => x.id)];
      for (const g of gone) e.deleted.add(g);
      for (const g of gone) emit(rec, { type: "session.updated", session_id: g, deleted: true });
    },
    stopSession: async (id, sid) => {
      await delay();
      fail(["not_running"]);
      const rec = recOf(id);
      const e = entryOf(id);
      const s = await find(id, sid);
      const m = mainOf(id, sid);
      if (s.state !== "working" && s.state !== "waiting") throw new BridgeError(409, "not_running", "the session is not running");
      if (m) {
        const signal = rec.turns?.get(m.root);
        if (signal) signal.cancelled = true;
        if (!isDefault(rec, m) && m.queue.length > 0) {
          m.paused = true;
          queueEvent(rec, m);
        }
      } else e.agentState.set(sid, "stopped");
      await announce(id, sid);
      return find(id, sid);
    },
    sendSessionMessage: (id, sid, text, opts) => sendTo(id, sid, text, opts),
    messageSession: async (id, sid, text, opts) => {
      await delay();
      fail(["not_continuable", "steer_unsupported"]);
      const e = entryOf(id);
      const s = await find(id, sid);
      if (s.kind !== "agent") throw new BridgeError(409, "not_agent_session", "main session messages use the session's message route");
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
    // A main session's own queue; the default session's is the project's (`v7.ts`).
    getSessionQueue: async (id, sid) => {
      if (isDefaultId(id, sid) && bridge.getQueue) return { ...(await bridge.getQueue(id)), session_id: sid };
      await delay();
      const m = sessionQueue(id, sid);
      return { paused: m.paused, messages: clone(m.queue), session_id: sid };
    },
    removeSessionQueued: async (id, sid, qid) => {
      if (isDefaultId(id, sid) && bridge.removeQueued) return bridge.removeQueued(id, qid);
      await delay();
      const m = sessionQueue(id, sid);
      if (!m.queue.some((q) => q.id === qid)) throw new BridgeError(404, "not_found", "queued message not found");
      m.queue = m.queue.filter((q) => q.id !== qid);
      queueEvent(recOf(id), m);
      await announce(id, sid);
    },
    clearSessionQueue: async (id, sid) => {
      if (isDefaultId(id, sid) && bridge.clearQueue) return bridge.clearQueue(id);
      await delay();
      const m = sessionQueue(id, sid);
      m.queue = [];
      queueEvent(recOf(id), m);
      await announce(id, sid);
    },
    resumeSessionQueue: async (id, sid) => {
      if (isDefaultId(id, sid) && bridge.resumeQueue) return bridge.resumeQueue(id);
      await delay();
      const rec = recOf(id);
      const m = sessionQueue(id, sid);
      m.paused = false;
      queueEvent(rec, m);
      if (!running(rec, m)) await afterTurn(rec, m.root);
    },
    sendSessionQueuedNow: async (id, sid, qid, opts) => {
      if (isDefaultId(id, sid) && bridge.sendQueuedNow) return bridge.sendQueuedNow(id, qid, opts);
      await delay();
      const rec = recOf(id);
      const m = sessionQueue(id, sid);
      const q = m.queue.find((x) => x.id === qid);
      if (!q) throw new BridgeError(404, "not_found", "queued message not found");
      m.queue = m.queue.filter((x) => x !== q);
      queueEvent(rec, m);
      const signal = rec.turns?.get(m.root);
      if (signal && opts?.interrupt) {
        signal.cancelled = true;
        m.queue.unshift({ ...q, waiting_for: "turn" });
        return;
      }
      if (!running(rec, m)) await start(id, m, q.text);
    },
    getSessionContext: async (id, sid) => {
      const m = mainOf(id, sid);
      const breakdown = await bridge.getContext(id, m?.root);
      const model = m?.model || breakdown.model;
      const scoped = { ...breakdown, model };
      if (isDefaultId(id, sid) && bridge.getContextOverview) {
        const overview = await bridge.getContextOverview(id);
        return { ...scoped, ...overview };
      }
      const labels: Record<string, string> = {
        system: "Instructions",
        tools: "Tool definitions",
        notes: "Notes and memory",
        messages: "Messages",
        tool_results: "Tool results",
        summary: "Compacted summary",
      };
      return {
        ...scoped,
        window: scoped.window_tokens,
        used: scoped.used_tokens,
        source: model.startsWith("acp:") ? ("agent" as const) : ("harness" as const),
        categories: model.startsWith("acp:") ? [] : scoped.parts.map((p) => ({ id: p.key, label: labels[p.key] ?? p.key, tokens: p.tokens })),
      };
    },
    compactSession: async (id) => {
      if (!bridge.compactNow) throw new BridgeError(404, "not_found", "compaction is not available");
      return bridge.compactNow(id);
    },
    getSessionLatestPlan: async (id, sid) => (isDefaultId(id, sid) && bridge.getLatestPlan ? bridge.getLatestPlan(id) : (await delay(), null)),
    rewindSession: async (id, sid, input) => {
      if (isDefaultId(id, sid) && bridge.rewind) return bridge.rewind(id, input);
      await delay();
      throw new BridgeError(409, "rewind_unavailable", "The demo rewinds the default session only.");
    },
    listApprovals: async (id, opts) => (await allApprovals(id)).filter(inSession(id, opts?.sessionId)),
    listInputs: async (id, opts) => (bridge.listInputs ? await bridge.listInputs(id) : []).filter(inSession(id, opts?.sessionId)),
    resolveApproval: async (id, aid, answer) => {
      const e = entryOf(id);
      const m = e.mains.find((x) => x.approvals.some((a) => a.id === aid));
      if (!m) {
        if (!bridge.resolveApproval) throw new BridgeError(404, "not_found", "approval not found");
        return bridge.resolveApproval(id, aid, answer);
      }
      await delay();
      m.approvals = m.approvals.filter((a) => a.id !== aid);
      const rec = recOf(id);
      emit(rec, { type: "approval.resolved", id: aid, decision: answer.decision, session_id: m.id });
      if (answer.decision !== "deny") (rec.lastStatus ??= new Map()).set(m.root, "completed");
      await announce(id, m.id);
    },
    deleteAllSessions: async (): Promise<DeleteAllSessionsResult> => {
      await delay();
      fail(["session_running"]);
      let deleted_sessions = 0;
      const now = new Date().toISOString();
      for (const [pid, rec] of records) {
        const e = entryOf(pid);
        deleted_sessions += e.mains.filter((m) => !e.deleted.has(m.id)).length;
        if (rec.turn) rec.turn.cancelled = true;
        rec.turn = null;
        if (rec.turns) {
          for (const sig of rec.turns.values()) sig.cancelled = true;
          rec.turns.clear();
        }
        rec.streaming.clear();
        rec.activeTools.clear();
        rec.messages.length = 0;
        rec.endings = [];
        rec.lastStatus?.clear();
        const prevOrch = rec.agents.find((a) => a.id === rec.project.orchestrator_agent_id);
        const sid = newId("ses");
        rec.agents.length = 0;
        const freshOrch: Agent = {
          id: newId("agt"),
          session_id: sid,
          project_id: pid,
          parent_id: null,
          depth: 0,
          role: prevOrch?.role ?? "orchestrator",
          title: "",
          task: "",
          model: prevOrch?.model ?? "claude-sonnet-5-5",
          tier: null,
          status: "idle",
          result: null,
          error: null,
          spawn_tool_use_id: null,
          input_tokens: 0,
          output_tokens: 0,
          created_at: now,
          started_at: now,
          finished_at: now,
        };
        rec.agents.push(freshOrch);
        rec.project.orchestrator_agent_id = freshOrch.id;
        rec.project.agent_count = 1;
        rec.project.status = "idle";
        rec.project.updated_at = now;
        const freshMain: Main = {
          id: sid,
          title: "",
          started_at: now,
          last_activity_at: now,
          model: freshOrch.model,
          root: freshOrch.id,
          queue: [],
          paused: false,
          approvals: [],
        };
        e.mains = [freshMain];
        e.archived.clear();
        e.titles.clear();
        e.deleted.clear();
        e.workspaces = e.workspaces.slice(0, 1);
        e.agentState.clear();
        e.agentTalk.clear();
        emit(rec, { type: "project.updated", project: clone(rec.project) });
      }
      importedByProject.clear();
      return { deleted_sessions, projects: records.size };
    },
    listWorkspaces: async (id: string): Promise<Workspace[]> => {
      await delay();
      return clone(entryOf(id).workspaces);
    },
    moveSessionToWorktree: async (id: string, sid: string, input: MoveToWorktreeInput = {}): Promise<MoveToWorktreeResult> => {
      await delay();
      const rec = recOf(id);
      const e = entryOf(id);
      const m = mainOf(id, sid);
      if (!m) throw new BridgeError(404, "not_found", `no session ${sid}`);
      if (running(rec, m)) throw new BridgeError(409, "workspace_in_use", "The session is running.");
      if (m.workspace?.kind === "worktree") {
        throw new BridgeError(409, "already_in_worktree", "This session already works in its own worktree.");
      }
      const branch = input.branch?.trim() || "octo/worktree";
      const wid = newId("wrk");
      const now = new Date().toISOString();
      const carry = input.carry_changes ?? true;
      const ws: Workspace = {
        id: wid,
        kind: "worktree",
        title: `Worktree · ${branch}`,
        state: "ready",
        branch,
        carry_changes: carry,
        created_at: now,
        folders: rec.project.folders.map((f) => ({
          workspace_id: wid,
          folder_id: f.id,
          folder_label: f.label,
          path: `/home/you/.octo/projects/demo/worktrees/${wid}/${f.label}`,
          repo_root: f.path,
          branch,
          shared: false,
        })),
      };
      e.workspaces.push(ws);
      m.workspace = { id: wid, kind: "worktree", title: ws.title, branch };
      emit(rec, { type: "workspace.updated", workspace: clone(ws) });
      await announce(id, sid);
      return { session: await find(id, sid), workspace: clone(ws) };
    },
    listImportableSessions: async (): Promise<ImportableSession[]> => {
      await delay();
      const now = Date.now();
      const allImported = new Set<string>();
      for (const keys of importedByProject.values()) for (const k of keys) allImported.add(k);
      return IMPORT_SEEDS.map((s) => {
        const started = now - s.hoursAgo * 3_600_000;
        const updated = started + (s.talk.length - 1) * 600_000 + 20_000;
        const matched = matchProject(s.cwd);
        const firstPrompt = s.talk[0]?.[0] ?? "";
        return {
          provider: s.provider,
          provider_label: s.provider_label,
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          model: s.model,
          started_at: new Date(started).toISOString(),
          updated_at: new Date(updated).toISOString(),
          message_count: s.talk.reduce((n, [q, a]) => n + (q ? 1 : 0) + (a ? 1 : 0), 0),
          exchange_count: s.talk.length,
          preview: firstPrompt,
          already_imported: allImported.has(`${s.provider}:${s.id}`),
          ...(matched ? { matched_project_id: matched.project.id, matched_project_name: matched.project.name } : {}),
        };
      });
    },
    importSessions: async (id: string, refs: ImportSessionRef[]): Promise<ImportSessionsResult> => {
      await delay();
      const rec = recOf(id);
      const e = entryOf(id);
      let keys = importedByProject.get(id);
      if (!keys) {
        keys = new Set();
        importedByProject.set(id, keys);
      }
      const imported: ProjectSession[] = [];
      let skipped = 0;
      const now = Date.now();
      for (const ref of refs) {
        const seed = IMPORT_SEEDS.find((s) => s.provider === ref.provider && s.id === ref.id);
        const key = `${ref.provider}:${ref.id}`;
        if (!seed || keys.has(key)) {
          skipped += 1;
          continue;
        }
        keys.add(key);
        const started = now - seed.hoursAgo * 3_600_000;
        const at = new Date(started).toISOString();
        const updated = new Date(started + (seed.talk.length - 1) * 600_000 + 20_000).toISOString();
        const sid = newId("ses");
        const root = addRoot(rec, sid, at, seed.model, "completed");
        addTalk(rec, root.id, seed.talk, started);
        const main: Main = {
          id: sid,
          title: seed.title,
          started_at: at,
          last_activity_at: updated,
          model: seed.model,
          root: root.id,
          seed: {
            id: seed.id,
            title: seed.title,
            state: "idle",
            hoursAgo: seed.hoursAgo,
            exchanges: seed.talk.length,
            model: seed.model,
            talk: seed.talk,
          },
          queue: [],
          paused: false,
          approvals: [],
        };
        e.mains.push(main);
        announceRoot(rec, root);
        const session = await mainSession(id, main);
        imported.push(session);
        emit(rec, { type: "session.created", session, session_id: sid });
      }
      if (imported.length > 0) emit(rec, { type: "project.updated", project: clone(rec.project) });
      return { imported, skipped };
    },
  };
}
