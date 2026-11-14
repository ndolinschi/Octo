import type { Agent } from "@octo/agent-client";
import { act, say, turn, type Ctx } from "./runtime";
import { clone, emit, newId, type ProjectRecord } from "./store";

/**
 * Parallel sessions in the demo: a main session's own root agent, and the long scripted turn that keeps a second session
 * of Orbit streaming next to the default one (`?demo=1`: two sessions of one project running at once).
 */

/** A root agent for main session `sid` (its conversation is this agent's messages, as in the harness since schema 15). */
export function addRoot(rec: ProjectRecord, sid: string, at: string, model: string, status: Agent["status"] = "idle"): Agent {
  const orch = rec.agents.find((a) => a.id === rec.project.orchestrator_agent_id);
  const root: Agent = {
    id: newId("agt"),
    session_id: sid,
    project_id: rec.project.id,
    parent_id: null,
    depth: 0,
    role: orch?.role ?? "orchestrator",
    title: "",
    task: "",
    model,
    tier: null,
    status,
    result: null,
    error: status === "failed" ? "The model returned an error." : null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: at,
    started_at: at,
    finished_at: at,
  };
  rec.agents.push(root);
  rec.project.agent_count = rec.agents.length;
  return root;
}

/** Request / answer pairs stored as a root's conversation (a seeded session's history). */
export function addTalk(rec: ProjectRecord, rootId: string, talk: readonly (readonly [string, string])[], startMs: number): void {
  talk.forEach(([q, a], i) => {
    const t = startMs + i * 600_000;
    rec.messages.push({ id: rec.nextMessageId++, agent_id: rootId, role: "user", content: [{ type: "text", text: q }], created_at: new Date(t).toISOString() });
    rec.messages.push({
      id: rec.nextMessageId++,
      agent_id: rootId,
      role: "assistant",
      content: [{ type: "text", text: a }],
      created_at: new Date(t + 20_000).toISOString(),
    });
  });
}

export const SYNC_PROMPT = "Refactor the offline sync queue so retries back off and survive an app restart.";

/** About three minutes of reading, editing and testing: a second session that streams while the default one works. */
export async function syncRefactor(ctx: Ctx, prompt: string): Promise<void> {
  await turn(ctx, prompt, async (c, orch) => {
    await act(
      c,
      orch,
      [{ name: "read_file", input: { path: "src/sync/queue.ts" }, result: "export class SyncQueue { … }", ms: 2500 }],
      "Reading the queue first.",
    );
    await act(c, orch, [{ name: "grep", input: { pattern: "retry", path: "src/sync" }, result: "src/sync/queue.ts:41\nsrc/sync/policy.ts:12", ms: 4000 }]);
    for (let i = 1; i <= 6; i++) {
      await act(
        c,
        orch,
        [{ name: "bash", input: { command: `yarn jest src/sync --testNamePattern="backoff ${i}"` }, result: `Tests: ${i} passed`, ms: 12_000 }],
        `Step ${i} of 6: moving one retry path onto the shared backoff policy and checking it.`,
      );
    }
    await say(c, orch, "The queue now persists to disk and every retry goes through `policy.ts` (exponential, capped at five minutes).");
  });
}

/** Starts `script` in session `rootId` now (a turn of a main session other than the default). */
export function startIn(rec: ProjectRecord, rootId: string, script: (ctx: Ctx) => Promise<void>): void {
  void script({ rec, t: Date.now(), signal: { cancelled: false }, root: rootId });
}

/** Announces a new root agent, as the harness does for a new session. */
export function announceRoot(rec: ProjectRecord, root: Agent): void {
  emit(rec, { type: "agent.created", agent: clone(root), ...(root.session_id ? { session_id: root.session_id } : {}) });
}
