import {
  BridgeError,
  type Approval,
  type Bridge,
  type ChangeDetail,
  type FileChange,
  type InputRequest,
  type ProjectSummary,
  type QueuedMessage,
  type QueueState,
  type TurnChanges,
} from "@octo/agent-client";
import { emit, newId, orchestratorOf, type ProjectRecord } from "./store";
import { CLIENT_AFTER, CLIENT_BEFORE, RETRY_AFTER, RETRY_BEFORE, SHOWCASE_PROMPT } from "./toolShowcase";
import { countLines, lineDiff } from "./reviewDiff";

/**
 * v7 for the demo bridge: a pending approval, an open form, queued messages and two turns with changes on the Atlas
 * project, and a live script when a message contains "v7" (an approval, a recorded change, a form and a queued message
 * arrive as events). Answers behave like the harness: 404 `not_found` once answered, 409 for the two revert refusals.
 */

type V7 = {
  approvals: Approval[];
  inputs: InputRequest[];
  queue: QueueState;
  changes: FileChange[];
  texts: Map<number, { before: string | null; after: string | null }>;
  nextChange: number;
};

const MIN = 60_000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const SEED_PROJECT = "Atlas";

const FORMAT_BEFORE = `export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function plural(n: number, one: string): string {
  return n === 1 ? one : one + "s";
}
`;
const FORMAT_AFTER = `const UNITS = ["B", "KB", "MB", "GB"] as const;

/** 1536 -> "1.5 KB"; negative and non-finite sizes read as "0 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return \`\${i === 0 ? n : (n / 1024 ** i).toFixed(1)} \${UNITS[i]}\`;
}

export function plural(n: number, one: string): string {
  return n === 1 ? one : one + "s";
}
`;
const TEST_AFTER = `import { formatBytes } from "./format";

test("zero and negative sizes read as 0 B", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(-5)).toBe("0 B");
});
`;

function change(
  id: number,
  turn: number,
  agent: string,
  path: string,
  kind: FileChange["kind"],
  added: number | null,
  removed: number | null,
  extra: Partial<FileChange> = {},
): FileChange {
  return {
    id,
    turn_id: turn,
    agent_id: agent,
    folder: "atlas",
    path,
    kind,
    added,
    removed,
    created_at: iso((30 - id) * MIN),
    note: "",
    source: "write_file",
    ...extra,
  };
}

function seed(rec: ProjectRecord): V7 {
  const orch = orchestratorOf(rec);
  const users = rec.messages.filter((m) => m.agent_id === orch.id && m.role === "user");
  const turnA = users.at(-2)?.id ?? 1;
  const turnB = users.at(-1)?.id ?? 2;
  const v: V7 = { approvals: [], inputs: [], queue: { paused: false, messages: [] }, changes: [], texts: new Map(), nextChange: 100 };
  const add = (c: FileChange, before: string | null, after: string | null) => {
    v.changes.push(c);
    v.texts.set(c.id, { before, after });
  };
  add(change(1, turnA, orch.id, "src/lib/format.ts", "modified", 9, 5), FORMAT_BEFORE, FORMAT_AFTER);
  add(change(2, turnA, orch.id, "src/lib/format.test.ts", "created", 6, 0), null, TEST_AFTER);
  add(change(3, turnA, orch.id, "dist/app.wasm", "modified", null, null, { note: "binary", source: "bash" }), null, null);
  add(change(4, turnB, orch.id, "docs/notes.md", "modified", null, null, { note: "no_preimage", source: "acp_turn" }), null, null);
  add(
    change(6, turnB, orch.id, "width/wide.txt", "modified", 1, 1),
    "wide line: " + "0123456789 ".repeat(40) + "\n",
    "wide line: " + "0123456789 ".repeat(40) + "changed\n",
  );
  add(change(5, turnB, orch.id, "src/stale.ts", "modified", 1, 1), "export const retries = 2;\n", "export const retries = 5;\n");
  // retest3 G2: the tool showcase turn's two edited files (real before / after, so the chat's previews and Changes agree).
  const showcase = users.find((m) => m.content.some((b) => b.type === "text" && b.text === SHOWCASE_PROMPT))?.id;
  if (showcase !== undefined) {
    const real = (id: number, path: string, before: string, after: string) => {
      const n = countLines(lineDiff(before, after, 0, false));
      add(change(id, showcase, orch.id, path, "modified", n.added, n.removed, { folder: "atlas-api", source: "write_file" }), before, after);
    };
    real(7, "src/http/retry.ts", RETRY_BEFORE, RETRY_AFTER);
    real(8, "src/http/client.ts", CLIENT_BEFORE, CLIENT_AFTER);
    // R2: five files in this request (the one the chat shows), so the reply's "N files changed" line shows its "+N more"
    // (three names, then the rest).
    real(9, "src/http/index.ts", 'export * from "./client";\n', 'export * from "./client";\nexport * from "./retry";\n');
    real(10, "src/http/timeouts.ts", "", "export const REQUEST_TIMEOUT_MS = 10_000;\n");
    real(11, "docs/retries.md", "# Retries\n", "# Retries\n\nUp to 5 attempts; each one is logged with its delay.\n");
  }
  v.approvals.push({
    id: newId("apr"),
    agent_id: orch.id,
    agent_label: "orchestrator",
    turn_id: turnB,
    kind: "command",
    title: "pnpm --filter @octo/ui test",
    detail: { command: "pnpm --filter @octo/ui test && git commit -am 'Handle zero and negative sizes'" },
    created_at: iso(40_000),
  });
  v.inputs.push({
    id: newId("inp"),
    agent_id: orch.id,
    agent_label: "orchestrator",
    turn_id: turnB,
    title: "Deploy settings",
    reason: "I need these before writing the deploy script. The token is stored by Octo's local service and never shown to the model.",
    fields: [
      { id: "name", label: "Service name", kind: "text", required: true },
      { id: "token", label: "Deploy token", kind: "secret", required: true },
      { id: "region", label: "Region", kind: "select", options: ["eu-west", "us-east", "ap-south"], required: true },
      { id: "smoke", label: "Run the smoke tests after deploying", kind: "confirm" },
    ],
    created_at: iso(20_000),
  });
  v.queue.messages.push(
    { id: newId("q"), text: "Then rename the helper to formatBytes and update its callers", created_at: iso(2 * MIN) },
    { id: newId("q"), text: "After that, run the full lint and summarise the warnings by file", created_at: iso(MIN) },
  );
  return v;
}

function turns(v: V7, only?: number): TurnChanges[] {
  const byTurn = new Map<number, FileChange[]>();
  for (const c of v.changes) byTurn.set(c.turn_id, [...(byTurn.get(c.turn_id) ?? []), c]);
  return [...byTurn.entries()]
    .filter(([id]) => only === undefined || id === only)
    .sort((a, b) => b[0] - a[0])
    .map(([turn_id, list]) => ({
      turn_id,
      files: list.map(({ id, agent_id, ...rest }) => ({ ...rest, change_ids: [id], agent_ids: [agent_id] })),
      added: list.reduce((n, c) => n + (c.added ?? 0), 0),
      removed: list.reduce((n, c) => n + (c.removed ?? 0), 0),
    }));
}

const attention = (rec: ProjectRecord, v: V7) =>
  emit(rec, { type: "project.attention", needs_you: v.approvals.length + v.inputs.length > 0, approvals: v.approvals.length, inputs: v.inputs.length });
const queued = (rec: ProjectRecord, v: V7) => emit(rec, { type: "queue.updated", paused: v.queue.paused, messages: structuredClone(v.queue.messages) });
const notFound = (what: string) => new BridgeError(404, "not_found", `${what} not found`);

/** The live script behind a message containing "v7": things arrive one by one, as events. */
function liveScript(rec: ProjectRecord, v: V7): void {
  const orch = orchestratorOf(rec);
  const turn = rec.messages.filter((m) => m.agent_id === orch.id && m.role === "user").at(-1)?.id ?? 0;
  const at = (ms: number, run: () => void) => setTimeout(run, ms);
  at(1200, () => {
    const c = change(v.nextChange++, turn, orch.id, "src/lib/format.ts", "modified", 4, 1, { created_at: iso() });
    v.changes.push(c);
    v.texts.set(c.id, { before: FORMAT_AFTER, after: FORMAT_AFTER.replace('"0 B"', '"0 B" /* empty */') });
    emit(rec, { type: "change.recorded", turn_id: turn, change: structuredClone(c) });
  });
  at(2200, () => {
    v.approvals.push({
      id: newId("apr"),
      agent_id: orch.id,
      agent_label: "orchestrator",
      turn_id: turn,
      kind: "write",
      title: "Write src/lib/format.ts",
      detail: { folder: "atlas", path: "src/lib/format.ts", diff: { added: 12, removed: 4 } },
      created_at: iso(),
    });
    const a = v.approvals.at(-1);
    if (a) emit(rec, { type: "approval.requested", approval: structuredClone(a) });
    attention(rec, v);
  });
  at(3400, () => {
    v.queue.messages.push({ id: newId("q"), text: "Then run the tests again", created_at: iso() });
    queued(rec, v);
  });
}

/**
 * "helper approval" (NEW-3): once the turn's sub-agent runs, its command asks for an approval; the approval goes when the
 * agent stops running (a stop, or the end of the turn).
 */
function helperApproval(rec: ProjectRecord, v: V7): void {
  const turn = rec.messages.filter((m) => m.agent_id === orchestratorOf(rec).id && m.role === "user").at(-1)?.id ?? 0;
  let once = false;
  const timer = setInterval(() => {
    const helper = rec.agents.find((a) => a.parent_id !== null && a.status === "running" && a.role === "Command runner");
    const asked = v.approvals.find((a) => a.agent_label === "Command runner");
    if (helper && !asked && !once) {
      once = true;
      const approval: Approval = {
        id: newId("apr"),
        agent_id: helper.id,
        agent_label: "Command runner",
        turn_id: turn,
        kind: "command",
        title: "pnpm db:check",
        detail: { command: "pnpm db:check" },
        created_at: iso(),
      };
      v.approvals.push(approval);
      emit(rec, { type: "approval.requested", approval: structuredClone(approval) });
      attention(rec, v);
    }
    if (!helper && asked) {
      v.approvals = v.approvals.filter((a) => a !== asked);
      emit(rec, { type: "approval.resolved", id: asked.id, decision: "deny" });
      attention(rec, v);
    }
    if (!helper && (asked || rec.turn === null)) clearInterval(timer);
  }, 1000);
}

/** Adds the v7 members (and a "v7" script on `sendMessage`) to a demo bridge. */
export function withDemoV7(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const states = new Map<string, V7>();
  const state = (id: string): { rec: ProjectRecord; v: V7 } => {
    const rec = records.get(id);
    if (!rec) throw notFound("project");
    let v = states.get(id);
    if (!v) {
      v = rec.project.name.startsWith(SEED_PROJECT)
        ? seed(rec)
        : { approvals: [], inputs: [], queue: { paused: false, messages: [] }, changes: [], texts: new Map(), nextChange: 100 };
      states.set(id, v);
    }
    return { rec, v };
  };
  const delay = () => new Promise((r) => setTimeout(r, 60));
  const clone = <T>(x: T): T => structuredClone(x);
  const sendMessage: Bridge["sendMessage"] = async (id, text) => {
    const sent = await base.sendMessage(id, text);
    if (/v7/i.test(text)) {
      const { rec, v } = state(id);
      liveScript(rec, v);
    }
    if (/helper approval/i.test(text)) {
      const { rec, v } = state(id);
      helperApproval(rec, v);
    }
    return sent;
  };
  // As the harness reports it (project/dto.go): `needs_you`, the counts and `attention: "needs_you"` while an approval or a form
  // waits; otherwise the base summary is left as it was (its own failed or idle state).
  const withAttention = <T extends ProjectSummary>(p: T): T => {
    const { v } = state(p.id);
    const approvals = v.approvals.length;
    const inputs = v.inputs.length;
    if (approvals + inputs === 0) return p;
    return { ...p, needs_you: true, pending_approvals: approvals, pending_inputs: inputs, attention: "needs_you" };
  };
  return {
    ...base,
    listProjects: async () => (await base.listProjects()).map(withAttention),
    getProject: async (id) => withAttention(await base.getProject(id)),
    sendMessage,
    sendOrQueueMessage: async (id, text) => {
      const { rec, v } = state(id);
      if (!rec.turn) return { message: await sendMessage(id, text) };
      const q: QueuedMessage = { id: newId("q"), text, created_at: iso() };
      v.queue.messages.push(q);
      queued(rec, v);
      return { queued: clone(q) };
    },
    getQueue: async (id) => (await delay(), clone(state(id).v.queue)),
    removeQueued: async (id, qid) => {
      await delay();
      const { rec, v } = state(id);
      if (!v.queue.messages.some((m) => m.id === qid)) throw notFound("queued message");
      v.queue.messages = v.queue.messages.filter((m) => m.id !== qid);
      queued(rec, v);
    },
    clearQueue: async (id) => {
      await delay();
      const { rec, v } = state(id);
      v.queue.messages = [];
      queued(rec, v);
    },
    resumeQueue: async (id) => {
      await delay();
      const { rec, v } = state(id);
      v.queue.paused = false;
      queued(rec, v);
    },
    sendQueuedNow: async (id, qid) => {
      await delay();
      const { rec, v } = state(id);
      const m = v.queue.messages.find((x) => x.id === qid);
      if (!m) throw notFound("queued message");
      v.queue.messages = v.queue.messages.filter((x) => x.id !== qid);
      queued(rec, v);
      if (rec.turn) rec.turn.cancelled = true;
      await sendMessage(id, m.text).catch(() => undefined);
    },
    listChanges: async (id, turnId) => (await delay(), turns(state(id).v, turnId)),
    getChange: async (id, cid): Promise<ChangeDetail> => {
      await delay();
      const { v } = state(id);
      const c = v.changes.find((x) => x.id === cid);
      const t = v.texts.get(cid);
      if (!c || !t) throw notFound("change");
      return { ...clone(c), before: t.before, after: t.after, diff_available: c.note === "" };
    },
    revertChange: async (id, cid) => {
      await delay();
      const { rec, v } = state(id);
      const c = v.changes.find((x) => x.id === cid);
      if (!c) throw notFound("change");
      if (c.note === "no_preimage") throw new BridgeError(409, "revert_unavailable", "the content before this change was not kept");
      if (c.path === "src/stale.ts") throw new BridgeError(409, "file_changed", "the file changed since this turn");
      emit(rec, { type: "file.changed", folder: c.folder, path: c.path, source: "agent" });
      return { folder: c.folder, path: c.path, size: 0, mtime: iso() };
    },
    listApprovals: async (id) => (await delay(), clone(state(id).v.approvals)),
    resolveApproval: async (id, aid, answer) => {
      await delay();
      const { rec, v } = state(id);
      if (!v.approvals.some((a) => a.id === aid)) throw notFound("approval");
      v.approvals = v.approvals.filter((a) => a.id !== aid);
      emit(rec, { type: "approval.resolved", id: aid, decision: answer.decision });
      attention(rec, v);
    },
    listInputs: async (id) => (await delay(), clone(state(id).v.inputs)),
    submitInput: async (id, iid, answer) => {
      await delay();
      const { rec, v } = state(id);
      const form = v.inputs.find((i) => i.id === iid);
      if (!form) throw notFound("form");
      v.inputs = v.inputs.filter((i) => i.id !== iid);
      const secrets = new Set(form.fields.filter((f) => f.kind === "secret").map((f) => f.id));
      const values = answer.values ?? {};
      emit(rec, {
        type: "input.resolved",
        id: iid,
        status: answer.skip ? "skipped" : "submitted",
        provided: Object.keys(values).filter((k) => secrets.has(k)),
        values: Object.fromEntries(Object.entries(values).filter(([k]) => !secrets.has(k))),
      });
      attention(rec, v);
    },
    putSecret: async (id) => {
      await delay();
      state(id);
    },
  };
}
