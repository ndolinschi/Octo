import {
  BridgeError,
  type Approval,
  type ApprovalRule,
  type Bridge,
  type CompactionMarker,
  type ContextOverview,
  type Message,
  type Plan,
  type RequestHit,
  type RewindFile,
  type RewindReport,
} from "@octo/agent-client";
import { clone, emit, newId, orchestratorOf, type ProjectRecord } from "./store";

/**
 * Parity B2–B7 for the demo bridge: modes and a plan after a plan-mode turn, "Always allow" rules and the approvals a message
 * containing "approvals demo" raises (an edit with its patch, a web fetch, a command), steering a queued message into a
 * running turn (an ACP orchestrator answers 409 `steer_unsupported`), rewind (a dry run, a file that blocks it, an ACP
 * session reset), manual compaction with its marker, Markdown export and the global request search.
 */

type Demo = {
  rules: ApprovalRule[];
  approvals: Approval[];
  plan: Plan | null;
  /** Manual compactions: the marker and how many tokens the conversation shrank to (for the context overview). */
  compacted: CompactionMarker[];
  /** `src/stale.ts` changes on disk between a rewind's dry run and its confirmation, once. */
  staleSeen: boolean;
};

const iso = () => new Date().toISOString();
const APPROVALS_DEMO = /approvals?\s+demo/i;

const PATCH = `--- a/src/lib/retry.ts
+++ b/src/lib/retry.ts
@@ -3,7 +3,9 @@
 export async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
   let last: unknown;
   for (let i = 0; i < attempts; i++) {
-    try { return await run(); } catch (e) { last = e; }
+    try {
+      return await run();
+    } catch (e) {
+      last = e;
+      await sleep(2 ** i * 100);
+    }
   }
   throw last;
 }
`;

const PLAN_TEXT = `**Plan: retry failed webhooks with backoff**

1. Add \`withRetry\` to \`src/lib/retry.ts\` (3 attempts, 100 ms doubling).
2. Wrap the delivery call in \`src/webhooks/deliver.ts\` and keep the failure reason on the last attempt.
3. Write a failing test first in \`test/retry.test.ts\`, then make it pass.
4. Run \`pnpm test\` and report anything that is slow or flaky.

Nothing changes until you approve this.`;

const textOf = (m: Message) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

export function withDemoParity(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const states = new Map<string, Demo>();
  const demo = (id: string): { rec: ProjectRecord; d: Demo } => {
    const rec = records.get(id);
    if (!rec) throw new BridgeError(404, "not_found", "project not found");
    let d = states.get(id);
    if (!d) {
      d = { rules: [], approvals: [], plan: null, compacted: [], staleSeen: false };
      states.set(id, d);
    }
    return { rec, d };
  };
  const delay = () => new Promise((r) => setTimeout(r, 60));
  const acp = (rec: ProjectRecord) => rec.project.models.orchestrator.startsWith("acp:");
  const prompts = (rec: ProjectRecord) => {
    const orch = orchestratorOf(rec);
    return rec.messages.filter((m) => m.agent_id === orch.id && m.role === "user" && textOf(m) !== "");
  };
  const contextUpdated = (rec: ProjectRecord) => emit(rec, { type: "context.updated", project_id: rec.project.id });

  /** The approvals "approvals demo" raises, one by one, like an agent would. */
  const raiseApprovals = (rec: ProjectRecord, d: Demo) => {
    const orch = orchestratorOf(rec);
    const turn = prompts(rec).at(-1)?.id ?? 0;
    const make = (a: Omit<Approval, "id" | "agent_id" | "agent_label" | "turn_id" | "created_at">) => ({
      ...a,
      id: newId("apr"),
      agent_id: orch.id,
      agent_label: "orchestrator",
      turn_id: turn,
      created_at: iso(),
    });
    const list: Approval[] = [
      make({
        kind: "write",
        title: "Edit src/lib/retry.ts",
        tool: "edit",
        detail: { folder: rec.project.folders[0]?.label ?? "main", path: "src/lib/retry.ts", diff: { added: 6, removed: 1 }, patch: PATCH },
        suggested_rule: { tool: "edit", match: "src/lib/retry.ts", exact: true },
      }),
      make({
        kind: "network",
        title: "Read the retry-after header rules before choosing the delays",
        tool: "web_fetch",
        detail: { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After" },
        suggested_rule: { tool: "web_fetch", match: "developer.mozilla.org", exact: false },
      }),
      make({
        kind: "command",
        title: "pnpm test",
        tool: "bash",
        detail: { command: "pnpm test --filter @octo/ui" },
        suggested_rule: { tool: "bash", match: "pnpm test", exact: false },
      }),
    ];
    list.forEach((a, i) =>
      setTimeout(
        () => {
          d.approvals.push(a);
          emit(rec, { type: "approval.requested", approval: clone(a) });
        },
        400 + i * 500,
      ),
    );
  };

  /** Records of the changes (base v7 layer): the files a rewind to `messageId` would touch. */
  const rewindFiles = async (id: string, messageId: number): Promise<RewindFile[]> => {
    const turns = (await base.listChanges?.(id)) ?? [];
    const files: RewindFile[] = [];
    for (const t of turns) {
      if (t.turn_id < messageId) continue;
      for (const f of t.files) files.push({ folder: f.folder, path: f.path, action: f.kind === "created" ? "delete" : "restore", change_ids: f.change_ids });
    }
    return files;
  };

  const rewindReport = async (id: string, messageId: number, dry: boolean): Promise<RewindReport> => {
    const { rec, d } = demo(id);
    const target = prompts(rec).find((m) => m.id === messageId);
    if (!target) throw new BridgeError(400, "invalid_request", "that is not a request of this conversation");
    if (rec.turn) throw new BridgeError(409, "turn_in_progress", "a turn is running");
    const files = await rewindFiles(id, messageId);
    // One file moves on disk between the check and the confirmation (the harness's 409), then stays blocking.
    const stale = files.some((f) => f.path === "src/stale.ts");
    const blocked = stale && (d.staleSeen || !dry);
    const cut = rec.messages.filter((m) => m.id >= messageId).length;
    const agents = rec.agents.filter((a) => a.parent_id !== null && a.created_at >= target.created_at).length;
    return {
      dry_run: dry,
      message_id: messageId,
      request_text: textOf(target),
      files,
      conflicts: blocked ? [{ folder: files.find((f) => f.path === "src/stale.ts")?.folder ?? "atlas", path: "src/stale.ts", reason: "modified_outside" }] : [],
      messages_cut: cut,
      agents_cut: agents,
      acp_session_reset: acp(rec),
    };
  };

  const markdown = (rec: ProjectRecord): string => {
    const list = prompts(rec);
    const orch = orchestratorOf(rec);
    const parts = [`# ${rec.project.name}`, ""];
    list.forEach((p, i) => {
      const next = list[i + 1]?.id ?? Infinity;
      const answer = rec.messages
        .filter((m) => m.agent_id === orch.id && m.role === "assistant" && m.id > p.id && m.id < next)
        .map(textOf)
        .filter(Boolean)
        .join("\n\n");
      parts.push(`## Request ${i + 1} · ${p.created_at}`, "", textOf(p), "", "### Answer", "", answer || "(no answer)", "");
    });
    return parts.join("\n");
  };

  const startTurn = (id: string, text: string, opts?: { mode?: "agent" | "ask" | "plan" }) =>
    base.sendOrQueueMessage?.(id, text, opts) ?? base.sendMessage(id, text).then((message) => ({ message }));

  /** A plan-mode turn ends with a plan once its script is done. */
  const planWhenDone = (id: string, turnId: number) => {
    const { rec, d } = demo(id);
    const poll = setInterval(() => {
      if (rec.turn) return;
      clearInterval(poll);
      d.plan = { id: newId("plan"), turn_id: turnId, text: PLAN_TEXT, status: "pending", created_at: iso(), approved_at: null };
      emit(rec, { type: "plan.created", plan: clone(d.plan) });
    }, 400);
  };

  const sendOrQueueMessage: NonNullable<Bridge["sendOrQueueMessage"]> = async (id, text, opts) => {
    const { rec, d } = demo(id);
    const running = rec.turn !== null;
    const sent = await startTurn(id, text, opts);
    if (!running && sent.message) {
      if (APPROVALS_DEMO.test(text)) raiseApprovals(rec, d);
      if (opts?.mode === "plan") planWhenDone(id, sent.message.id);
    }
    return sent;
  };

  return {
    ...base,
    sendOrQueueMessage,
    sendMessage: async (id, text) => {
      const sent = await base.sendMessage(id, text);
      const { rec, d } = demo(id);
      if (APPROVALS_DEMO.test(text)) raiseApprovals(rec, d);
      return sent;
    },
    getProject: async (id) => {
      const project = await base.getProject(id);
      return { ...project, mode: demo(id).rec.project.mode ?? "agent" };
    },
    updateProject: async (id, patch) => {
      const { rec } = demo(id);
      if (patch.mode) rec.project.mode = patch.mode;
      const rest = { ...patch };
      delete rest.mode;
      const next = await base.updateProject(id, rest);
      return { ...next, mode: rec.project.mode ?? "agent" };
    },

    // B3 — the plan
    getLatestPlan: async (id) => {
      await delay();
      const { d } = demo(id);
      if (!d.plan) throw new BridgeError(404, "not_found", "no plan yet");
      return clone(d.plan);
    },
    approvePlan: async (id, planId) => {
      await delay();
      const { rec, d } = demo(id);
      if (d.plan?.id !== planId) throw new BridgeError(404, "not_found", "plan not found");
      if (d.plan.status !== "pending") throw new BridgeError(409, "plan_not_pending", "this plan was already approved");
      if (rec.turn) throw new BridgeError(409, "turn_in_progress", "a turn is running");
      d.plan = { ...d.plan, status: "approved", approved_at: iso() };
      emit(rec, { type: "plan.approved", plan: clone(d.plan) });
      const sent = await startTurn(id, "The plan above is approved. Carry it out.", { mode: "agent" });
      if (!sent.message) throw new BridgeError(409, "turn_in_progress", "a turn is running");
      return { plan: clone(d.plan), message: sent.message };
    },

    // B2, B4 — approvals and rules
    listApprovals: async (id) => [...((await base.listApprovals?.(id)) ?? []), ...clone(demo(id).d.approvals)],
    resolveApproval: async (id, aid, answer) => {
      const { rec, d } = demo(id);
      const mine = d.approvals.find((a) => a.id === aid);
      if (!mine) return base.resolveApproval?.(id, aid, answer);
      await delay();
      d.approvals = d.approvals.filter((a) => a.id !== aid);
      if (answer.decision === "allow_always") {
        if (!mine.suggested_rule) throw new BridgeError(422, "no_rule", "no rule can be saved for this request");
        const rule: ApprovalRule = { id: newId("rule"), ...mine.suggested_rule, created_at: iso() };
        d.rules.push(rule);
        emit(rec, { type: "approval_rule.created", rule: clone(rule) });
      }
      emit(rec, { type: "approval.resolved", id: aid, decision: answer.decision });
    },
    listApprovalRules: async (id) => (await delay(), clone(demo(id).d.rules)),
    deleteApprovalRule: async (id, rid) => {
      await delay();
      const { rec, d } = demo(id);
      if (!d.rules.some((r) => r.id === rid)) throw new BridgeError(404, "not_found", "rule not found");
      d.rules = d.rules.filter((r) => r.id !== rid);
      emit(rec, { type: "approval_rule.deleted", id: rid });
    },

    // B6 — steering
    steerQueued: async (id, qid) => {
      await delay();
      const { rec } = demo(id);
      if (acp(rec)) throw new BridgeError(409, "steer_unsupported", "this agent cannot take input mid-turn");
      const queue = (await base.getQueue?.(id)) ?? { paused: false, messages: [] };
      const item = queue.messages.find((m) => m.id === qid);
      if (!item) throw new BridgeError(404, "not_found", "queued message not found");
      // The running turn takes it at its next tool boundary: the row leaves the queue and the text lands in the transcript.
      setTimeout(() => {
        void base.removeQueued?.(id, qid).then(() => {
          const orch = orchestratorOf(rec);
          const message: Message = {
            id: rec.nextMessageId++,
            agent_id: orch.id,
            role: "user",
            content: [{ type: "text", text: item.text }],
            created_at: iso(),
          };
          rec.messages.push(message);
          emit(rec, { type: "message.created", message: clone(message) });
          emit(rec, { type: "message.steered", queue_id: qid, text: item.text });
        });
      }, 1500);
      return { steered: true };
    },

    // B5 — rewind
    rewind: async (id, input) => {
      await delay();
      const dry = input.dry_run === true;
      const report = await rewindReport(id, input.message_id, dry);
      const { rec, d } = demo(id);
      if (report.conflicts.length > 0) {
        d.staleSeen = true;
        if (dry) return report;
        throw new BridgeError(409, "rewind_conflict", "a file changed outside Octo since the agent's last edit");
      }
      if (dry) return report;
      const target = rec.messages.find((m) => m.id === input.message_id);
      const hidden = new Set(rec.agents.filter((a) => a.parent_id !== null && target !== undefined && a.created_at >= target.created_at).map((a) => a.id));
      rec.messages = rec.messages.filter((m) => m.id < input.message_id && !hidden.has(m.agent_id));
      rec.agents = rec.agents.filter((a) => !hidden.has(a.id));
      rec.project.agent_count = rec.agents.length;
      d.compacted = d.compacted.filter((c) => c.upto_message_id < input.message_id);
      if (d.plan && d.plan.turn_id >= input.message_id) d.plan = null;
      emit(rec, { type: "conversation.rewound", message_id: input.message_id, request_text: report.request_text });
      contextUpdated(rec);
      return report;
    },

    // B7 — compaction, context, export, search
    compactNow: async (id) => {
      await delay();
      const { rec, d } = demo(id);
      if (rec.turn) throw new BridgeError(409, "turn_in_progress", "a turn is running");
      if (acp(rec)) throw new BridgeError(409, "compact_unsupported", "the agent compacts itself");
      const orch = orchestratorOf(rec);
      const mine = rec.messages.filter((m) => m.agent_id === orch.id);
      const since = d.compacted.at(-1)?.upto_message_id ?? 0;
      const fresh = mine.filter((m) => m.id > since);
      if (fresh.length < 2) throw new BridgeError(409, "nothing_to_compact", "fewer than two messages since the last compaction");
      const upto = fresh.at(-1);
      if (!upto) throw new BridgeError(409, "nothing_to_compact", "nothing to compact");
      const at = iso();
      const marker: CompactionMarker = {
        upto_message_id: upto.id,
        at,
        summary_tokens: 1_240,
        label: "history compacted",
        manual: true,
        message_count: fresh.length,
      };
      d.compacted.push(marker);
      emit(rec, { type: "agent.compacted", agent_id: orch.id, upto_message_id: upto.id, summary_tokens: 1_240, at, manual: true, message_count: fresh.length });
      contextUpdated(rec);
      return { upto_message_id: upto.id, at, summary_tokens: 1_240, message_count: fresh.length, manual: true as const };
    },
    getTranscript: async (id, agentId) => {
      const transcript = await base.getTranscript(id, agentId);
      const { d } = demo(id);
      const orch = orchestratorOf(demo(id).rec);
      return agentId === orch.id ? { ...transcript, compactions: [...transcript.compactions, ...clone(d.compacted)] } : transcript;
    },
    getContextOverview: async (id) => {
      const raw: ContextOverview = (await base.getContextOverview?.(id)) as ContextOverview;
      const { d } = demo(id);
      if (d.compacted.length === 0 || raw.source !== "harness") return raw;
      // After a compaction the conversation is a summary: most of what was there is gone.
      const categories = raw.categories.map((c) =>
        c.id === "messages" || c.id === "tool_results"
          ? { ...c, tokens: Math.round(c.tokens * 0.12) }
          : c.id === "summary"
            ? { ...c, tokens: c.tokens + 1_240 }
            : c,
      );
      return { ...raw, categories, used: categories.reduce((n, c) => n + c.tokens, 0), compacted_at: d.compacted.at(-1)?.at ?? iso() };
    },
    exportConversationUrl: (id) => `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown(demo(id).rec))}`,
    searchRequests: async (query, limit = 20) => {
      await delay();
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: RequestHit[] = [];
      for (const rec of records.values()) {
        for (const m of prompts(rec).reverse()) {
          const text = textOf(m);
          if (words.every((w) => text.toLowerCase().includes(w))) {
            hits.push({ project_id: rec.project.id, project_name: rec.project.name, message_id: m.id, snippet: text.slice(0, 160), date: m.created_at });
          }
        }
      }
      return hits.slice(0, limit);
    },
  };
}
