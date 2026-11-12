import {
  BridgeError,
  type Bridge,
  type ContextReceipt,
  type ProjectSession,
  type SessionsParams,
  type MemoryFile,
  type MemoryHit,
  type MemorySearchKind,
  type MemorySearchParams,
  type MemorySearchResult,
  type Message,
  type RememberKind,
  type ReceiptBlock,
  type Task,
  type TaskFact,
} from "@octo/agent-client";
import { addSession, buildSessions, forget, listSessions, mainSessions, makeCurrent, sessionDetail, type DemoSessions } from "./memorySessions";
import { CROSS_SUPERSEDES, EXTRA_FACTS, FILES, TASKS } from "./memoryData";

/**
 * Demo orchestrator memory (M1 + M2 receipts) for `?demo=1`, so the Memory view can be judged: 30 task records with 80
 * facts, 12 memory files, search, and a context receipt per request. Quotes are exact substrings of the project's real
 * demo requests and link to them. `?memory=none` leaves the bridge without memory (an older harness), `empty` has no
 * records, `fail` fails every read.
 */
export type DemoMemoryMode = "on" | "none" | "empty" | "fail";

export function memoryMode(search: string): DemoMemoryMode {
  const v = new URLSearchParams(search).get("memory");
  return v === "none" || v === "empty" || v === "fail" ? v : "on";
}

const DAY = 86_400_000;
/** The subject an item kept on purpose is about, from its task's title (the harness's `about`). */
function subjectOf(title: string): string {
  if (/token|login|cookie|session|auth|threat|password|oauth/i.test(title)) return "Auth";
  if (/billing|stripe|invoice|plan|webhook|pricing/i.test(title)) return "Billing";
  if (/postgres|pool|migration|database|sql|index/i.test(title)) return "Database";
  if (/ci\b|rust|build|docker|deploy|helm|terraform|toolchain|release/i.test(title)) return "Infrastructure";
  return "Product";
}

const KINDS: RememberKind[] = ["fact", "decision", "preference", "todo", "decision"];
const LATENCY_MS = 120;

const delay = (ms = LATENCY_MS) => new Promise<void>((r) => setTimeout(r, ms));

export type Request = { id: number; text: string; at: string };
export type Store = { tasks: Task[]; files: MemoryFile[]; requests: Request[]; replies: Request[]; sessions?: DemoSessions };

function textOf(m: Message): string {
  return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

/** The first sentence of a request (an exact substring), at most 120 characters. */
function quoteOf(text: string): string | null {
  const t = text.trim();
  if (t.length < 12) return null;
  const end = t.search(/[.!?\n]/);
  const sentence = end > 12 ? t.slice(0, end) : t;
  return sentence.length > 120 ? sentence.slice(0, sentence.lastIndexOf(" ", 120)) : sentence;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function buildTasks(requests: Request[], now: number): Task[] {
  const ids = TASKS.map((_, i) => `tsk_${String(30 - i).padStart(2, "0")}${["a", "k", "q", "w"][i % 4] ?? ""}`);
  const tasks = TASKS.map((spec, i): Task => {
    const created = now - spec.age * DAY - (i % 5) * 3_600_000;
    const updated = Math.min(now - 60_000, created + Math.min(spec.age, 3) * DAY * 0.6);
    // Newer tasks link to newer requests.
    const req = requests.length ? requests[requests.length - 1 - (i % requests.length)] : undefined;
    const messageId = req?.id ?? 9000 - i;
    const texts = [...spec.facts, ...(EXTRA_FACTS[i] ?? [])];
    const facts: TaskFact[] = texts.map((raw, j) => {
      const date = created + ((updated - created) * (j + 1)) / (texts.length + 1);
      const base: TaskFact = { id: `f${j + 1}`, text: raw.replace(/^~/, ""), date: iso(date), message_id: messageId };
      // Every third item was kept on purpose (`remember`): it carries a kind and who kept it; the rest the harness learnt itself.
      const kept = j % 3 === 1;
      const fact: TaskFact = kept
        ? {
            ...base,
            kind: KINDS[(i + j) % KINDS.length] ?? "fact",
            remembered_by: i % 4 === 0 ? "user" : "orchestrator",
            about: subjectOf(spec.title),
          }
        : base;
      return raw.startsWith("~") ? { ...fact, superseded_by: `f${j + 2}` } : fact;
    });
    const quote = req ? quoteOf(req.text) : null;
    const goalBy = spec.goalBy ?? "digest";
    return {
      id: ids[i] ?? `tsk_${i}`,
      title: spec.title,
      status: spec.status,
      goal: spec.goal,
      goal_by: goalBy,
      auto: goalBy === "harness",
      constraints: spec.constraints ?? [],
      acceptance: spec.acceptance ?? [],
      quotes: quote && req ? [{ text: quote, message_id: req.id }] : [],
      decisions: spec.decisions ?? [],
      outcome: spec.outcome ?? "",
      files: spec.files ?? [],
      facts,
      message_ids: [messageId],
      created_at: iso(created),
      updated_at: iso(updated),
    };
  });
  for (const [[ot, of], [nt, nf]] of CROSS_SUPERSEDES) {
    const older = tasks[ot]?.facts[of];
    const newer = tasks[nt];
    if (older && newer?.facts[nf]) older.superseded_by = `${newer.id}/f${nf + 1}`;
  }
  return tasks;
}

export function buildFiles(now: number): MemoryFile[] {
  return FILES.map((f) => ({
    path: f.path,
    summary: f.summary,
    content: f.content,
    size: new TextEncoder().encode(f.content).length,
    created_at: iso(now - (f.age + 4) * DAY),
    updated_at: iso(now - f.age * DAY),
  }));
}

function snippet(text: string, word: string): string {
  const flat = text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(word.toLowerCase()));
  const from = Math.max(0, at - 80);
  const cut = flat.slice(from, from + 280);
  return `${from > 0 ? "…" : ""}${cut}${from + 280 < flat.length ? "…" : ""}`;
}

type Doc = { hit: Omit<MemoryHit, "snippet">; text: string; kind: MemorySearchKind };

function docsOf(store: Store): Doc[] {
  const docs: Doc[] = [];
  for (const t of store.tasks) {
    const text = [t.title, t.goal, ...t.constraints, ...t.acceptance, ...t.decisions, t.outcome, ...t.quotes.map((q) => q.text)].join("\n");
    docs.push({ kind: "tasks", text, hit: { kind: "task", id: t.id, title: t.title, date: t.updated_at } });
    for (const f of t.facts) {
      const hit: Omit<MemoryHit, "snippet"> = { kind: "fact", id: `${t.id}/${f.id}`, title: t.title, date: f.date, message_id: f.message_id, task_id: t.id };
      docs.push({ kind: "facts", text: f.text, hit: f.superseded_by ? { ...hit, superseded: true } : hit });
    }
  }
  for (const f of store.files)
    docs.push({ kind: "files", text: `${f.path}\n${f.summary}\n${f.content ?? ""}`, hit: { kind: "file", id: f.path, title: f.path, date: f.updated_at } });
  for (const r of [...store.requests, ...store.replies]) {
    docs.push({ kind: "messages", text: r.text, hit: { kind: "message", id: String(r.id), title: r.text.split("\n", 1)[0]?.slice(0, 80) ?? "", date: r.at } });
  }
  for (const e of store.sessions?.exchanges ?? []) {
    if (e.removed) continue;
    docs.push({
      kind: "exchanges",
      text: `${e.request}\n${e.answer}`,
      hit: {
        kind: "exchange",
        id: e.id,
        title: e.request.split("\n", 1)[0]?.slice(0, 80) ?? "",
        date: e.started_at,
        ...(e.session_id ? { session_id: e.session_id } : {}),
      },
    });
  }
  return docs;
}

/** The harness's search rules, approximately (memory.md "Search"): all words, else half of the significant ones. */
export function search(store: Store, params: MemorySearchParams): MemorySearchResult {
  const words = params.q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  const kinds = params.in?.length ? params.in : null;
  const after = params.after ? Date.parse(params.after) : null;
  const before = params.before ? Date.parse(params.before) : null;
  const docs = docsOf(store).filter((d) => {
    if (kinds && !kinds.includes(d.kind)) return false;
    const at = Date.parse(d.hit.date);
    return (after === null || at >= after) && (before === null || at < before);
  });
  const has = (d: Doc, w: string) => d.text.toLowerCase().includes(w);
  let found = words.length ? docs.filter((d) => words.every((w) => has(d, w))) : [];
  if (!found.length && words.length > 1) {
    const significant = words.filter((w) => w.length >= 4);
    found = docs.filter((d) => significant.length > 0 && significant.filter((w) => has(d, w)).length * 2 >= significant.length);
  }
  found.sort((a, b) => Number(a.hit.superseded ?? false) - Number(b.hit.superseded ?? false) || Date.parse(b.hit.date) - Date.parse(a.hit.date));
  const hits = found.slice(0, Math.min(10, params.limit ?? 10)).map((d) => ({ ...d.hit, snippet: snippet(d.text, words.find((w) => has(d, w)) ?? "") }));
  return hits.length ? { hits } : { hits: [], message: "nothing in memory matches" };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function block(name: string, tokens: number, cap: number, ids: string[]): ReceiptBlock {
  return { name, tokens: cap > 0 ? Math.min(cap, tokens) : tokens, cap, count: ids.length, ids };
}

/** A receipt per request: the oldest has none (a turn before receipts), the second is a `full`-mode turn. */
export function receipt(store: Store, turnId: number): ContextReceipt {
  const at = store.requests.findIndex((r) => r.id === turnId);
  const req = store.requests[at];
  if (!req || at < 1) throw new BridgeError(404, "not_found", "no context receipt for this turn");
  const h = hash(req.text + String(turnId));
  const base = { turn_id: turnId, recent_exchanges: 5, created_at: req.at, cleared_calls: at % 4 === 0 ? 3 : 0 };
  if (at === 1) {
    const tokens = 38_000 + (h % 9000);
    return {
      ...base,
      mode: "full",
      blocks: [
        block(
          "history",
          tokens,
          0,
          store.requests.slice(0, at + 1).map((r) => String(r.id)),
        ),
      ],
      total_tokens: tokens,
      caps_total: 0,
      message_count: (at + 1) * 2 - 1,
    };
  }
  const open = store.tasks.filter((t) => t.status === "open");
  const window = store.requests.slice(Math.max(0, at - 5), at);
  const facts = open.flatMap((t) => t.facts.filter((f) => !f.superseded_by).map((f) => `${t.id}/${f.id}`));
  const blocks = [
    block(
      "memory_index",
      60 + store.files.length * 24,
      1500,
      store.files.map((f) => f.path),
    ),
    block(
      "open_tasks",
      1900 + (h % 1400),
      3000,
      open.map((t) => t.id),
    ),
    block(
      "recent_window",
      at % 3 === 0 ? 12_000 : 3800 + (h % 7000),
      12_000,
      window.map((r) => String(r.id)),
    ),
    block("facts", facts.length * 16, 1500, facts),
    block("current_turn", Math.ceil(req.text.length / 4) + 12, 0, [String(turnId)]),
  ];
  return {
    ...base,
    mode: "window",
    blocks,
    total_tokens: blocks.reduce((n, b) => n + b.tokens, 0),
    caps_total: 18_000,
    message_count: window.length * 2 + 1,
  };
}

/** The demo bridge with the memory methods (see the module comment for the modes). */
export function withDemoMemory(bridge: Bridge, mode: DemoMemoryMode): Bridge {
  if (mode === "none") return bridge;
  const stores = new Map<string, Promise<Store>>();
  const readThread = async (projectId: string): Promise<{ requests: Request[]; replies: Request[] }> => {
    const agents = await bridge.listAgents(projectId);
    const orchestrator = agents.find((a) => a.parent_id === null);
    const messages = orchestrator ? await bridge.listMessages(projectId, orchestrator.id) : [];
    const texts = messages.map((m) => ({ id: m.id, text: textOf(m), at: m.created_at, role: m.role })).filter((m) => m.text.trim() !== "");
    return { requests: texts.filter((m) => m.role === "user"), replies: texts.filter((m) => m.role === "assistant") };
  };
  const storeOf = (projectId: string): Promise<Store> => {
    let s = stores.get(projectId);
    if (!s) {
      s = (async () => {
        const { requests, replies } = await readThread(projectId);
        const now = Date.now();
        if (mode === "empty") return { tasks: [], files: [], requests, replies, sessions: { sessions: [], exchanges: [] } };
        return {
          tasks: buildTasks(requests, now),
          files: buildFiles(now),
          requests,
          replies,
          sessions: buildSessions(
            requests.map((r) => r.id),
            now,
          ),
        };
      })();
      stores.set(projectId, s);
    }
    return s;
  };
  const read = async <T>(projectId: string, f: (s: Store) => T): Promise<T> => {
    await delay();
    if (mode === "fail") throw new BridgeError(503, "unavailable", "the memory store could not be read");
    return f(await storeOf(projectId));
  };
  const fileOf = (s: Store, path: string): MemoryFile => {
    const f = s.files.find((x) => x.path === path);
    if (!f) throw new BridgeError(404, "not_found", `no memory file ${path}`);
    return f;
  };
  return {
    ...bridge,
    listTasks: (pid) => read(pid, (s) => [...s.tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
    listMemory: (pid) =>
      read(pid, (s) => ({
        files: s.files.map(({ content: _content, ...f }) => f),
        index: s.files.map((f) => `- ${f.path}: ${f.summary}`).join("\n"),
      })),
    getMemoryFile: (pid, path) => read(pid, (s) => ({ ...fileOf(s, path) })),
    putMemoryFile: (pid, path, content, summary) =>
      read(pid, (s) => {
        const now = iso(Date.now());
        const size = new TextEncoder().encode(content).length;
        if (size > 64 * 1024) throw new BridgeError(400, "too_large", "a memory file holds at most 64 kB");
        const old = s.files.find((x) => x.path === path);
        const next: MemoryFile = { path, summary: summary ?? old?.summary ?? "", content, size, created_at: old?.created_at ?? now, updated_at: now };
        s.files = [next, ...s.files.filter((x) => x.path !== path)];
        return { ...next };
      }),
    deleteMemoryFile: (pid, path) =>
      read(pid, (s) => {
        fileOf(s, path);
        s.files = s.files.filter((x) => x.path !== path);
      }),
    searchMemory: (pid, params) => read(pid, (s) => search(s, params)),
    listMemorySessions: (pid, params) => read(pid, (s) => (s.sessions ? listSessions(s.sessions, params?.limit, params?.before) : [])),
    getMemorySession: (pid, sid) =>
      read(pid, (s) => {
        const d = s.sessions ? sessionDetail(s.sessions, sid) : null;
        if (!d) throw new BridgeError(404, "not_found", `no session ${sid}`);
        return d;
      }),
    // Project sessions (schema 13) on top of the memory sessions: each memory session is a main session, the open one is
    // current; the agent sessions come from the base demo bridge, re-parented to the current main session.
    listSessions: async (pid, params?: SessionsParams) => {
      const agents = bridge.listSessions ? await bridge.listSessions(pid, { kind: "agent", archived: "all" }) : [];
      return read(pid, (s) => {
        const d = s.sessions;
        if (!d) return [];
        const current = d.sessions.find((x) => x.open)?.id;
        const archived = params?.archived ?? false;
        const all: ProjectSession[] = [...mainSessions(d, agents.length), ...agents.map((a) => (current ? { ...a, parent_session_id: current } : a))];
        return all
          .filter((x) => (params?.kind ? x.kind === params.kind : true) && (params?.state ? x.state === params.state : true))
          .filter((x) => archived === "all" || x.archived === archived)
          .filter((x) => (params?.before ? x.started_at < params.before : true))
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(0, params?.limit ?? 50);
      });
    },
    getSession: async (pid, sid) => {
      const agentSessions = bridge.listSessions ? await bridge.listSessions(pid, { kind: "agent", archived: "all" }) : [];
      return read(pid, (s) => {
        const d = s.sessions;
        const detail = d ? sessionDetail(d, sid) : null;
        const main = d ? mainSessions(d, agentSessions.length).find((x) => x.id === sid) : undefined;
        if (d && detail && main) return { session: main, exchanges: detail.exchanges, children: main.current ? agentSessions : [] };
        const agent = agentSessions.find((x) => x.id === sid);
        if (!agent) throw new BridgeError(404, "not_found", `no session ${sid}`);
        return { session: agent, exchanges: [], children: [] };
      });
    },
    createSession: (pid, title) =>
      read(pid, (s) => {
        if (!s.sessions) throw new BridgeError(404, "not_found", "no sessions");
        const made = addSession(s.sessions, title ?? "New session", Date.now());
        const main = mainSessions(s.sessions, 0).find((x) => x.id === made.id);
        if (!main) throw new BridgeError(404, "not_found", `no session ${made.id}`);
        return main;
      }),
    resumeSession: (pid, sid) =>
      read(pid, (s) => {
        if (!s.sessions || !makeCurrent(s.sessions, sid)) throw new BridgeError(409, "not_main_session", "only a main session can be resumed");
        const main = mainSessions(s.sessions, 0).find((x) => x.id === sid);
        if (!main) throw new BridgeError(404, "not_found", `no session ${sid}`);
        return main;
      }),
    patchSession: async (pid, sid, patch) => {
      const isMain = await read(pid, (s) => s.sessions?.sessions.some((x) => x.id === sid) ?? false);
      if (!isMain) {
        if (!bridge.patchSession) throw new BridgeError(404, "not_found", `no session ${sid}`);
        return bridge.patchSession(pid, sid, patch);
      }
      return read(pid, (s) => {
        const d = s.sessions;
        const m = d?.sessions.find((x) => x.id === sid);
        if (!d || !m) throw new BridgeError(404, "not_found", `no session ${sid}`);
        if (patch.archived === true && m.open) throw new BridgeError(409, "current_session", "the current session cannot be archived");
        if (patch.title !== undefined) {
          if (patch.title.trim() === "") throw new BridgeError(400, "invalid_request", "a title cannot be empty");
          m.title = patch.title.trim();
        }
        if (patch.archived !== undefined) {
          d.archived ??= new Set();
          if (patch.archived) d.archived.add(sid);
          else d.archived.delete(sid);
        }
        const main = mainSessions(d, 0).find((x) => x.id === sid);
        if (!main) throw new BridgeError(404, "not_found", `no session ${sid}`);
        return main;
      });
    },
    forgetExchange: (pid, eid) =>
      read(pid, (s) => {
        if (!s.sessions || !forget(s.sessions, eid)) throw new BridgeError(404, "not_found", `no exchange ${eid}`);
      }),
    rememberFact: (pid, input) =>
      read(pid, (s) => {
        const task = s.tasks.find((t) => t.status === "open") ?? s.tasks[0];
        if (!task) throw new BridgeError(409, "no_task", "there is no task to attach this to yet");
        const fact: TaskFact = {
          id: `f${task.facts.length + 1}`,
          text: input.text,
          date: iso(Date.now()),
          message_id: task.message_ids[0] ?? 0,
          kind: input.kind ?? "fact",
          remembered_by: "user",
          ...(input.about ? { about: input.about } : {}),
        };
        task.facts = [...task.facts, fact];
        task.updated_at = fact.date;
        return { task_id: task.id, fact };
      }),
    forgetFact: (pid, taskId, factId) =>
      read(pid, (s) => {
        const task = s.tasks.find((t) => t.id === taskId);
        if (!task?.facts.some((f) => f.id === factId)) throw new BridgeError(404, "not_found", `no fact ${taskId}/${factId}`);
        task.facts = task.facts.filter((f) => f.id !== factId);
      }),
    getTurnContext: async (pid, turnId) => {
      const s = await read(pid, (x) => x);
      // A request made after the memory first loaded is not in the store yet: read the thread again on a miss.
      if (!s.requests.some((r) => r.id === turnId)) Object.assign(s, await readThread(pid));
      return receipt(s, turnId);
    },
  };
}
