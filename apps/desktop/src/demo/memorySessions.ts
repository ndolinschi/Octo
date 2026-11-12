import type { MemoryExchange, MemorySession, MemorySessionDetail, Message, ProjectSession } from "@octo/agent-client";

/**
 * Demo sessions for `?demo=1` (orchestrator memory M4): four sessions of different ages with several exchanges, a
 * failed one, a stopped one, a long Markdown answer (folds), Russian text, and a removed marker. `turn_id`s point at the
 * project's real demo requests where there are any, so "Open in conversation" lands on a real message.
 */
export type DemoSessions = { sessions: MemorySession[]; exchanges: MemoryExchange[]; archived?: Set<string> };

const H = 3_600_000;
const DAY = 24 * H;

const LONG_ANSWER = `The login flow has three moving parts. Here is how they fit together.

## Where the code lives

- \`src/auth/session.ts\` creates and verifies the signed cookie.
- \`src/auth/refresh.ts\` rotates refresh tokens; each one is used once.
- \`src/routes/login.ts\` is the only route that sets the cookie.

## What I changed

1. Refresh tokens are now hashed before they are stored.
2. A reused token revokes the whole family.
3. The cookie is \`HttpOnly\`, \`Secure\` and \`SameSite=Lax\`.

\`\`\`ts
export async function rotate(raw: string): Promise<Pair> {
  const row = await tokens.find(hash(raw));
  if (!row || row.usedAt) {
    await tokens.revokeFamily(row?.family);
    throw new AuthError("refresh token reused");
  }
  await tokens.markUsed(row.id);
  return issue(row.user, row.family);
}
\`\`\`

## Cost of the change

| Step | Before | After |
| --- | --- | --- |
| Refresh | 11 ms | 14 ms |
| Login | 38 ms | 41 ms |
| Revoke family | n/a | 6 ms |

## Not done

- Existing sessions stay valid until they expire; there is no forced logout.
- The admin UI still shows raw token ids.

Run \`pnpm test auth\` to see the 14 new cases.`;

const RU_ANSWER = `Готово. Калькулятор умеет сложение, вычитание, умножение и деление, понимает скобки и унарный минус.

Ошибки разбора возвращаются с позицией символа, например «ожидалась закрывающая скобка на позиции 7».`;

type Spec = {
  ageMs: number;
  durationMs: number;
  request: string;
  answer: string;
  status?: MemoryExchange["status"];
  model?: string;
  files?: string[];
  agents?: string[];
  cost?: number | null;
  removed?: boolean;
};

const SESSIONS: { title: string; reason?: string; summary?: string; specs: Spec[] }[] = [
  {
    title: "Harden the login flow",
    specs: [
      {
        ageMs: 5 * H,
        durationMs: 41_000,
        request: "Harden the login flow. Refresh tokens must be single use.",
        answer: LONG_ANSWER,
        files: ["src/auth/refresh.ts", "src/auth/session.ts", "src/routes/login.ts"],
        agents: ["Explorer", "Test writer"],
        cost: 0.1832,
      },
      {
        ageMs: 4.5 * H,
        durationMs: 9_000,
        request: "Why is the cookie SameSite=Lax and not Strict?",
        answer:
          "Strict would drop the cookie on the redirect back from the identity provider, so the first request after login would arrive signed out. Lax still blocks cross-site POSTs, which is the case that matters.",
        cost: 0.0124,
      },
      { ageMs: 4 * H, durationMs: 3_000, request: "Run the auth tests again", answer: "", status: "failed", cost: null },
      {
        ageMs: 3.5 * H,
        durationMs: 22_000,
        request: "Run the auth tests again, I fixed the config.",
        answer: "All 14 auth tests pass.\n\n```\nauth › rotate › rejects a reused token  ok\n```",
        cost: 0.0411,
        files: [],
      },
      { ageMs: 3 * H, durationMs: 6_000, request: "Remove the debug logging I asked for earlier", answer: "", removed: true },
      {
        ageMs: 2 * H,
        durationMs: 12_000,
        request: "Summarise what is left to do",
        answer: "Two things: a forced logout for sessions issued before today, and the admin UI, which still prints raw token ids.",
        status: "stopped",
        cost: 0.0069,
      },
    ],
  },
  {
    title: "Напиши калькулятор со скобками",
    specs: [
      {
        ageMs: 26 * H,
        durationMs: 18_000,
        request: "Напиши калькулятор со скобками на TypeScript",
        answer: RU_ANSWER,
        files: ["src/calc.ts", "src/calc.test.ts"],
        model: "claude-sonnet",
        cost: 0.0522,
      },
      {
        ageMs: 25.5 * H,
        durationMs: 8_000,
        request: "Добавь степень и проверку деления на ноль",
        answer: "Добавил оператор `^` (правая ассоциативность) и ошибку «деление на ноль» с позицией.",
        files: ["src/calc.ts"],
        cost: 0.0207,
      },
      { ageMs: 25 * H, durationMs: 5_000, request: "Спасибо!", answer: "Пожалуйста.", cost: 0.0011 },
    ],
  },
  {
    title: "Plan the 0.4 release",
    reason: "clear",
    summary: "Release 0.4 is blocked on the schema 8 migration, installer signing and one flaky e2e case. Nothing else is open.",
    specs: [
      {
        ageMs: 3 * DAY + 2 * H,
        durationMs: 30_000,
        request: "Plan the 0.4 release: what is blocking it?",
        answer: "Three blockers: the migration for schema 8, the installer signing step and one flaky e2e case. Everything else can ship as is.",
        agents: ["Release checker"],
        cost: 0.0903,
      },
      // No "/clear" exchange: the harness stores a boundary marker (`conversations[]`), never a request and an answer.
    ],
  },
  {
    title: "Why does the build take two minutes?",
    specs: [
      {
        ageMs: 8 * DAY,
        durationMs: 55_000,
        request: "Why does the build take two minutes?",
        answer: "Most of it is the Monaco chunk and the sidecar build. Warm caches bring the UI build to 18 seconds; the sidecar is the rest.",
        agents: ["Profiler"],
        cost: 0.1177,
      },
    ],
  },
];

export function buildSessions(requestIds: number[], now: number): DemoSessions {
  const sessions: MemorySession[] = [];
  const exchanges: MemoryExchange[] = [];
  let n = 0;
  SESSIONS.forEach((s, si) => {
    const id = `ses_${si + 1}`;
    const rows = s.specs.map((spec): MemoryExchange => {
      n += 1;
      const started = now - spec.ageMs;
      return {
        id: `exc_${String(n).padStart(2, "0")}`,
        session_id: id,
        turn_id: requestIds.length ? (requestIds[(n * 7) % requestIds.length] ?? 0) : 1000 + n,
        message_id: spec.answer ? 2000 + n : 0,
        request: spec.removed ? "" : spec.request,
        answer: spec.answer,
        answer_truncated: false,
        status: spec.status ?? "completed",
        started_at: new Date(started).toISOString(),
        duration_ms: spec.durationMs,
        model: spec.removed ? "" : (spec.model ?? "claude-sonnet-4"),
        files: spec.files ?? [],
        agents: spec.agents ?? [],
        tokens: { input: 1800 + n * 311, output: 240 + n * 97 },
        cost_usd: spec.cost ?? null,
        ...(spec.removed ? { removed: true } : {}),
      };
    });
    const live = rows.filter((r) => !r.removed);
    const last = rows[rows.length - 1];
    sessions.push({
      id,
      title: s.title,
      started_at: rows[0]?.started_at ?? new Date(now).toISOString(),
      ended_at: last ? new Date(Date.parse(last.started_at) + last.duration_ms).toISOString() : new Date(now).toISOString(),
      exchanges: live.length,
      open: si === 0,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.summary ? { summary: s.summary, summary_source: "model" as const } : {}),
    });
    exchanges.push(...rows);
  });
  // The oldest session starts archived, so the Sessions tab's Archived filter has something to show.
  const oldest = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
  return { sessions, exchanges, archived: new Set(oldest ? [oldest.id] : []) };
}

export function listSessions(d: DemoSessions, limit = 50, before?: string): MemorySession[] {
  return d.sessions
    .filter((s) => before === undefined || s.started_at < before)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit)
    .map((s) => ({ ...s, exchanges: d.exchanges.filter((e) => e.session_id === s.id && !e.removed).length }));
}

export function sessionDetail(d: DemoSessions, id: string): MemorySessionDetail | null {
  const session = listSessions(d).find((s) => s.id === id);
  return session ? { session, exchanges: d.exchanges.filter((e) => e.session_id === id).map((e) => ({ ...e })) } : null;
}

/** Forget leaves a marker with the texts gone (what the harness does). */
export function forget(d: DemoSessions, id: string): boolean {
  const e = d.exchanges.find((x) => x.id === id);
  if (!e) return false;
  Object.assign(e, { removed: true, request: "", answer: "", files: [], agents: [] });
  return true;
}

/**
 * The memory sessions as the project sessions of the harness (schema 13): each is a main session, the open one is current
 * (it can take a message, the others say "Resume this session"). `children` is filled by the caller (agent sessions).
 */
export function mainSessions(d: DemoSessions, children: number): ProjectSession[] {
  // States for the demo: the newest other sessions rest in different ways (idle, stopped, waiting for an answer).
  const others = listSessions(d, 200).filter((m) => !m.open && !d.archived?.has(m.id));
  const REST = ["idle", "stopped", "waiting"] as const;
  return listSessions(d, 200).map((m) => {
    const failed = m.exchanges > 0 && d.exchanges.filter((e) => e.session_id === m.id).at(-1)?.status === "failed";
    const at = others.findIndex((o) => o.id === m.id);
    return {
      id: m.id,
      kind: "main" as const,
      title: m.title,
      state: failed ? ("failed" as const) : m.open || at < 0 ? ("idle" as const) : (REST[at] ?? ("idle" as const)),
      model: "claude-sonnet-4",
      started_at: m.started_at,
      last_activity_at: m.ended_at,
      exchanges: m.exchanges,
      children: m.open ? children : 0,
      current: m.open,
      archived: d.archived?.has(m.id) ?? false,
      ...(m.summary ? { summary: m.summary } : {}),
      can_message: m.open,
      ...(m.open ? {} : { message_blocked: { code: "not_current", message: "Resume this session to continue it" } }),
    };
  });
}

/** One main session's requests and answers as the messages of the orchestrator's conversation (for its transcript). */
export function sessionMessages(d: DemoSessions, id: string, agentId: string): Message[] {
  let n = 100;
  return d.exchanges
    .filter((e) => e.session_id === id && !e.removed)
    .flatMap((e) => [
      {
        id: (n += 1),
        agent_id: agentId,
        role: "user" as const,
        content: [{ type: "text" as const, text: e.request }],
        created_at: e.started_at,
        session_id: id,
      },
      ...(e.answer
        ? [
            {
              id: (n += 1),
              agent_id: agentId,
              role: "assistant" as const,
              content: [{ type: "text" as const, text: e.answer }],
              created_at: new Date(Date.parse(e.started_at) + e.duration_ms).toISOString(),
              session_id: id,
              ...(e.status === "stopped" ? { stopped: true } : {}),
            },
          ]
        : []),
    ]);
}

/** Deletes a session with its exchanges; false when there is no such session. */
export function removeSession(d: DemoSessions, id: string): boolean {
  const at = d.sessions.findIndex((s) => s.id === id);
  if (at < 0) return false;
  d.sessions.splice(at, 1);
  d.exchanges = d.exchanges.filter((e) => e.session_id !== id);
  d.archived?.delete(id);
  return true;
}

/** Makes `id` the open session (resuming it, or a new one just added); false when there is no such session. */
export function makeCurrent(d: DemoSessions, id: string): boolean {
  if (!d.sessions.some((s) => s.id === id)) return false;
  for (const s of d.sessions) s.open = s.id === id;
  d.archived?.delete(id);
  return true;
}

/** A new empty main session, made current (what `POST /sessions` and `/clear` do). */
export function addSession(d: DemoSessions, title: string, now: number): MemorySession {
  const at = new Date(now).toISOString();
  const session: MemorySession = { id: `ses_${d.sessions.length + 1}`, title, started_at: at, ended_at: at, exchanges: 0, open: false };
  d.sessions.push(session);
  makeCurrent(d, session.id);
  return session;
}
