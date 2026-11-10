import type { Agent, ContentBlock, Message, Note, Tier } from "@octo/agent-client";
import { agentById, clone, emit, newId, orchestratorOf, writeDemoFile, type ProjectRecord } from "./store";

/**
 * Scripted agent runtime. Each script "thread" carries its own clock `t`: steps whose
 * time is already in the past complete instantly (back-filling history), later steps
 * wait in real time and stream events to subscribers.
 */
export type Ctx = { rec: ProjectRecord; t: number; signal: { cancelled: boolean } };

/** `content` (write_file only) is what the demo file system receives when the call succeeds. */
export type ToolSpec = { name: string; input: Record<string, unknown>; result: string; ms?: number; error?: boolean; content?: string };

export type ChildSpec = {
  role: string;
  title: string;
  task: string;
  tier: Tier;
  /** An ACP agent from a plugin (`spawn_agent` with `agent`): the child's model is `acp:{id}`, no tier. */
  acp?: string;
  run(ctx: Ctx, agentId: string): Promise<string>;
};

const CANCELLED = Symbol("cancelled");
const MODEL: Record<Tier, string> = {
  fast: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
};

export async function sleep(ctx: Ctx, ms: number): Promise<void> {
  if (ctx.signal.cancelled) throw CANCELLED;
  const target = ctx.t + ms;
  if (target > Date.now()) {
    while (Date.now() < target) {
      await new Promise((r) => setTimeout(r, Math.min(250, target - Date.now())));
      if (ctx.signal.cancelled) throw CANCELLED;
    }
    ctx.t = Date.now();
  } else {
    await Promise.resolve();
    ctx.t = target;
  }
}

const iso = (ctx: Ctx) => new Date(ctx.t).toISOString();

function touch(ctx: Ctx) {
  ctx.rec.project.updated_at = iso(ctx);
}

function addMessage(ctx: Ctx, agentId: string, role: Message["role"], content: ContentBlock[]): Message {
  const message: Message = { id: ctx.rec.nextMessageId++, agent_id: agentId, role, content, created_at: iso(ctx) };
  ctx.rec.messages.push(message);
  touch(ctx);
  emit(ctx.rec, { type: "message.created", message: clone(message) });
  return message;
}

function updateAgent(ctx: Ctx, agentId: string, patch: Partial<Agent>): Agent {
  const agent = Object.assign(agentById(ctx.rec, agentId), patch);
  emit(ctx.rec, { type: "agent.updated", agent: clone(agent) });
  return agent;
}

function charge(ctx: Ctx, agentId: string, outputChars: number) {
  const agent = agentById(ctx.rec, agentId);
  const history = ctx.rec.messages.filter((m) => m.agent_id === agentId).length;
  updateAgent(ctx, agentId, {
    input_tokens: agent.input_tokens + 1400 + history * 420,
    output_tokens: agent.output_tokens + Math.ceil(outputChars / 3.6) + 24,
  });
}

async function stream(ctx: Ctx, agentId: string, text: string): Promise<void> {
  let i = 0;
  while (i < text.length) {
    const size = 3 + ((i * 7) % 6);
    const chunk = text.slice(i, i + size);
    i += size;
    ctx.rec.streaming.set(agentId, (ctx.rec.streaming.get(agentId) ?? "") + chunk);
    emit(ctx.rec, { type: "message.delta", agent_id: agentId, text: chunk });
    await sleep(ctx, 36);
  }
  ctx.rec.streaming.delete(agentId);
}

/** Assistant text with no tool calls. */
export async function say(ctx: Ctx, agentId: string, text: string): Promise<void> {
  await sleep(ctx, 900);
  await stream(ctx, agentId, text);
  addMessage(ctx, agentId, "assistant", [{ type: "text", text }]);
  charge(ctx, agentId, text.length);
}

/** Assistant message with optional text and tool calls, followed by their results. */
export async function act(ctx: Ctx, agentId: string, tools: ToolSpec[], text?: string): Promise<void> {
  await sleep(ctx, 700);
  if (text) await stream(ctx, agentId, text);
  const uses = tools.map((t) => ({ id: newId("toolu"), spec: t }));
  addMessage(ctx, agentId, "assistant", [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...uses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.spec.name, input: u.spec.input })),
  ]);
  charge(ctx, agentId, (text?.length ?? 0) + 120 * tools.length);
  for (const u of uses) {
    ctx.rec.activeTools.set(u.id, { agentId, name: u.spec.name });
    emit(ctx.rec, { type: "tool.started", agent_id: agentId, tool_use_id: u.id, name: u.spec.name });
  }
  await sleep(ctx, Math.max(...tools.map((t) => t.ms ?? 600)));
  for (const u of uses) {
    ctx.rec.activeTools.delete(u.id);
    emit(ctx.rec, { type: "tool.finished", agent_id: agentId, tool_use_id: u.id, is_error: Boolean(u.spec.error) });
    if (u.spec.name === "save_note" && !u.spec.error) saveNote(ctx, String(u.spec.input.title), String(u.spec.input.content));
    if (u.spec.name === "write_file" && !u.spec.error && u.spec.content !== undefined) agentWrite(ctx, u.spec);
    if (u.spec.name === "edit" && !u.spec.error && u.spec.content !== undefined) acpWrite(ctx, u.spec);
  }
  addMessage(
    ctx,
    agentId,
    "user",
    uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: u.spec.result, is_error: Boolean(u.spec.error) })),
  );
}

function agentWrite(ctx: Ctx, spec: ToolSpec) {
  const folder = typeof spec.input.folder === "string" ? spec.input.folder : ctx.rec.project.folders[0]?.label;
  const path = String(spec.input.path ?? "").replace(/^\.\//, "");
  if (folder && ctx.rec.project.folders.some((f) => f.label === folder)) writeDemoFile(ctx.rec, folder, path, spec.content ?? "", "agent", ctx.t);
}

/** An ACP agent's edit: its locations are absolute paths; the demo writes the first one inside a project folder. */
function acpWrite(ctx: Ctx, spec: ToolSpec) {
  const locations = Array.isArray(spec.input.locations) ? (spec.input.locations as { path?: unknown }[]) : [];
  for (const l of locations) {
    const abs = typeof l.path === "string" ? l.path : "";
    const folder = ctx.rec.project.folders.find((f) => abs.startsWith(`${f.path}/`));
    if (folder) return void writeDemoFile(ctx.rec, folder.label, abs.slice(folder.path.length + 1), spec.content ?? "", "agent", ctx.t);
  }
}

export function saveNote(ctx: Ctx, title: string, content: string, author: Note["author"] = "orchestrator"): void {
  const existing = ctx.rec.notes.find((n) => n.title === title);
  const note: Note = existing
    ? Object.assign(existing, { content, updated_at: iso(ctx) })
    : { id: newId("note"), title, content, author, created_at: iso(ctx), updated_at: iso(ctx) };
  if (!existing) ctx.rec.notes.push(note);
  emit(ctx.rec, { type: "note.changed", note: clone(note), note_id: note.id });
}

/** Spawn several sub-agents from one assistant message; they run concurrently. */
export async function delegate(ctx: Ctx, parentId: string, children: ChildSpec[], text?: string): Promise<void> {
  await sleep(ctx, 800);
  if (text) await stream(ctx, parentId, text);
  const parent = agentById(ctx.rec, parentId);
  const uses = children.map((c) => ({ id: newId("toolu"), spec: c }));
  addMessage(ctx, parentId, "assistant", [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...uses.map((u) => ({
      type: "tool_use" as const,
      id: u.id,
      name: "spawn_agent",
      input: u.spec.acp
        ? { role: u.spec.role, title: u.spec.title, task: u.spec.task, agent: u.spec.acp }
        : { role: u.spec.role, title: u.spec.title, task: u.spec.task, tier: u.spec.tier },
    })),
  ]);
  charge(ctx, parentId, (text?.length ?? 0) + children.reduce((n, c) => n + c.task.length, 0));

  const results = await Promise.all(
    uses.map(async (u) => {
      const child = { ...ctx, t: ctx.t + 120 };
      await sleep(child, 0);
      const agent: Agent = {
        id: newId("agt"),
        project_id: ctx.rec.project.id,
        parent_id: parentId,
        depth: parent.depth + 1,
        role: u.spec.role,
        title: u.spec.title,
        task: u.spec.task,
        model: u.spec.acp ? `acp:${u.spec.acp}` : MODEL[u.spec.tier],
        tier: u.spec.acp ? null : u.spec.tier,
        status: "running",
        result: null,
        error: null,
        spawn_tool_use_id: u.id,
        input_tokens: 0,
        output_tokens: 0,
        created_at: iso(child),
        started_at: iso(child),
        finished_at: null,
      };
      ctx.rec.agents.push(agent);
      ctx.rec.project.agent_count = ctx.rec.agents.length;
      emit(ctx.rec, { type: "agent.created", agent: clone(agent) });
      addMessage(child, agent.id, "user", [{ type: "text", text: u.spec.task }]);
      ctx.rec.activeTools.set(u.id, { agentId: parentId, name: "spawn_agent" });
      emit(ctx.rec, { type: "tool.started", agent_id: parentId, tool_use_id: u.id, name: "spawn_agent" });
      let outcome: { content: string; error: boolean };
      try {
        const result = await u.spec.run(child, agent.id);
        updateAgent(child, agent.id, { status: "completed", result, finished_at: iso(child) });
        outcome = { content: result, error: false };
      } catch (e) {
        if (e === CANCELLED) throw e;
        const message = e instanceof Error ? e.message : String(e);
        updateAgent(child, agent.id, { status: "failed", error: message, finished_at: iso(child) });
        outcome = { content: `Sub-agent failed: ${message}`, error: true };
      }
      ctx.rec.activeTools.delete(u.id);
      emit(ctx.rec, { type: "tool.finished", agent_id: parentId, tool_use_id: u.id, is_error: outcome.error });
      return { use: u, outcome, t: child.t };
    }),
  );
  ctx.t = Math.max(ctx.t, ...results.map((r) => r.t));
  addMessage(
    ctx,
    parentId,
    "user",
    results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.use.id, content: r.outcome.content, is_error: r.outcome.error })),
  );
}

/** One orchestrator turn: user prompt, scripted body, then status bookkeeping. */
export async function turn(ctx: Ctx, prompt: string, body: (ctx: Ctx, orchestratorId: string) => Promise<void>): Promise<void> {
  const rec = ctx.rec;
  const orch = orchestratorOf(rec);
  rec.turn = ctx.signal;
  addMessage(ctx, orch.id, "user", [{ type: "text", text: prompt }]);
  updateAgent(ctx, orch.id, { status: "running", started_at: iso(ctx), finished_at: null });
  rec.project.status = "running";
  emit(rec, { type: "project.updated", project: clone(rec.project) });

  let status: "completed" | "failed" | "cancelled" = "completed";
  let error: string | null = null;
  try {
    await body(ctx, orch.id);
  } catch (e) {
    status = e === CANCELLED ? "cancelled" : "failed";
    error = e === CANCELLED ? null : e instanceof Error ? e.message : String(e);
    ctx.t = Math.max(ctx.t, Date.now());
    for (const a of rec.agents) {
      if (a.status === "running" && a.parent_id !== null) {
        updateAgent(ctx, a.id, { status: "cancelled", error: "Cancelled by user", finished_at: iso(ctx) });
      }
    }
    rec.streaming.clear();
    rec.activeTools.clear();
  }
  updateAgent(ctx, orch.id, { status: "idle", finished_at: iso(ctx) });
  rec.project.status = "idle";
  rec.turn = null;
  touch(ctx);
  emit(rec, { type: "project.updated", project: clone(rec.project) });
  emit(rec, { type: "turn.finished", status, error });
}
