import { autoDescription, charCount } from "../lib/notes";
import { listed, newDemoNote } from "./notes";
import type { Agent, ContentBlock, Message, Note, PlanEntry, Tier } from "@octo/agent-client";
import { agentById, clone, emit, newId, orchestratorOf, writeDemoFile, type ProjectRecord } from "./store";
import { errorMessage } from "../lib/format";

/**
 * Scripted agent runtime. Each script "thread" carries its own clock `t`: steps whose
 * time is already in the past complete instantly (back-filling history), later steps
 * wait in real time and stream events to subscribers.
 */
/** `root`: the root agent of the main session the turn runs in (parallel sessions); absent: the project's default session. */
export type Ctx = { rec: ProjectRecord; t: number; signal: { cancelled: boolean }; root?: string };

/** `content` (write_file only) is what the demo file system receives when the call succeeds. */
export type ToolSpec = {
  name: string;
  input: Record<string, unknown>;
  result: string;
  ms?: number;
  error?: boolean;
  content?: string;
  /** Stopped while it runs: the error result an ACP agent answers `session/cancel` with ("rejected"); absent: no result, like the built-in loop. */
  onCancel?: string;
};

export type ChildSpec = {
  role: string;
  title: string;
  task: string;
  tier: Tier;
  /** An ACP agent from a plugin (`spawn_agent` with `agent`): the child's model is `acp:{id}`, no tier. */
  acp?: string;
  /** The child's own clock start (ms); in the past it plays in at once with its historical times (decision 101 demo). */
  startAt?: number;
  /** The router's decision for an `auto` spawn (`route_choice`, `route_reason`, `route_band`). */
  route?: { choice: string; reason: string; band?: "easy" | "medium" | "hard" };
  run(ctx: Ctx, agentId: string): Promise<string>;
};

/** Thrown by a scripted child to end it as the person's Stop does (status cancelled; the turn goes on). */
export class StoppedByUser extends Error {
  constructor() {
    super("Cancelled by user");
  }
}

/** A sub-agent's own stop (its agent session's Stop): the agent ends cancelled at its next step; false when it is not running. */
export function stopDemoAgent(rec: ProjectRecord, agentId: string): boolean {
  const stop = rec.agentStops?.get(agentId);
  if (!stop || stop.cancelled) return false;
  stop.cancelled = true;
  return true;
}

/** An agent's whole plan, as an ACP agent's `agent.plan` sends it (also kept on its row). */
export function setPlan(ctx: Ctx, agentId: string, entries: PlanEntry[]): void {
  Object.assign(agentById(ctx.rec, agentId), { plan: entries });
  emit(ctx.rec, { type: "agent.plan", agent_id: agentId, entries: clone(entries) });
}

const CANCELLED = Symbol("cancelled");
const MODEL: Record<Tier, string> = {
  fast: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
};

export async function sleep(ctx: Ctx, ms: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- CANCELLED is a sentinel the runner compares by identity
  if (ctx.signal.cancelled) throw CANCELLED;
  const target = ctx.t + ms;
  if (target > Date.now()) {
    while (Date.now() < target) {
      await new Promise<void>((r) => {
        const timer: ReturnType<typeof setTimeout> & { unref?: () => void } = setTimeout(r, Math.min(250, target - Date.now()));
        timer.unref?.();
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- sentinel, see above
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

/** The demo ACP agent's context window, as its `usage_update` would report it. */
const ACP_CONTEXT = 200_000;

function charge(ctx: Ctx, agentId: string, outputChars: number) {
  const agent = agentById(ctx.rec, agentId);
  const history = ctx.rec.messages.filter((m) => m.agent_id === agentId).length;
  const input = agent.input_tokens + 1400 + history * 420;
  updateAgent(ctx, agentId, {
    input_tokens: input,
    output_tokens: agent.output_tokens + Math.ceil(outputChars / 3.6) + 24,
    // An ACP agent reports its context occupancy (`usage_update`): the demo's grows with its transcript.
    ...(agent.model.startsWith("acp:")
      ? { context_used: Math.min(ACP_CONTEXT, 1800 + history * 640), context_size: ACP_CONTEXT }
      : { context_used: Math.min(ACP_CONTEXT * 0.9, 3200 + history * 1900), context_size: ACP_CONTEXT }),
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
    emit(ctx.rec, { type: "tool.started", agent_id: agentId, tool_use_id: u.id, name: u.spec.name, started_at: iso(ctx) });
  }
  try {
    await sleep(ctx, Math.max(...tools.map((t) => t.ms ?? 600)));
  } catch (e) {
    const cut = uses.filter((u) => u.spec.onCancel !== undefined);
    if (e === CANCELLED && cut.length) {
      ctx.t = Math.max(ctx.t, Date.now());
      for (const u of cut) emit(ctx.rec, { type: "tool.finished", agent_id: agentId, tool_use_id: u.id, is_error: true });
      addMessage(
        ctx,
        agentId,
        "user",
        cut.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: u.spec.onCancel ?? "", is_error: true })),
      );
    }
    throw e;
  }
  // As the harness times them (tool timings): each call ran its own `ms`; the batch waited for the longest.
  const ran = (u: (typeof uses)[number]) => u.spec.ms ?? 600;
  for (const u of uses) {
    ctx.rec.activeTools.delete(u.id);
    emit(ctx.rec, { type: "tool.finished", agent_id: agentId, tool_use_id: u.id, is_error: Boolean(u.spec.error), duration_ms: ran(u) });
    if (u.spec.name === "save_note" && !u.spec.error) saveNote(ctx, String(u.spec.input.title), String(u.spec.input.content));
    if (u.spec.name === "write_file" && !u.spec.error && u.spec.content !== undefined) agentWrite(ctx, u.spec);
    if (u.spec.name === "edit" && !u.spec.error && u.spec.content !== undefined) acpWrite(ctx, u.spec);
  }
  addMessage(
    ctx,
    agentId,
    "user",
    uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: u.spec.result, is_error: Boolean(u.spec.error), duration_ms: ran(u) })),
  );
}

function agentWrite(ctx: Ctx, spec: ToolSpec) {
  const folder = typeof spec.input.folder === "string" ? spec.input.folder : ctx.rec.project.folders[0]?.label;
  const path = (typeof spec.input.path === "string" ? spec.input.path : "").replace(/^\.\//, "");
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
  const note = existing
    ? Object.assign(
        existing,
        { content, size: charCount(content), updated_at: iso(ctx) },
        existing.description_auto ? { description: autoDescription(content) } : {},
      )
    : newDemoNote(title, content, Date.parse(iso(ctx)), { author });
  if (!existing) ctx.rec.notes.push(note);
  emit(ctx.rec, { type: "note.changed", note: clone(listed(note)), note_id: note.id });
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
      // Each child has its own stop (decision 101: a sub-agent's session can be stopped while the turn goes on).
      const own = { cancelled: false };
      const parentSignal = ctx.signal;
      const signal = {
        get cancelled() {
          return parentSignal.cancelled || own.cancelled;
        },
      };
      const child: Ctx = { ...ctx, t: u.spec.startAt ?? ctx.t + 120, signal };
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
        ...(u.spec.route ? { route_choice: u.spec.route.choice, route_reason: u.spec.route.reason, route_band: u.spec.route.band ?? null } : {}),
      };
      (ctx.rec.agentStops ??= new Map()).set(agent.id, own);
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
        if (e === CANCELLED && parentSignal.cancelled) throw e;
        if (e === CANCELLED || e instanceof StoppedByUser) {
          // Stopped on its own (its session's Stop): the agent reads stopped, its parent gets the stop as the call's result.
          child.t = e === CANCELLED ? Math.max(child.t, Date.now()) : child.t;
          for (const [id, t] of ctx.rec.activeTools) if (t.agentId === agent.id) ctx.rec.activeTools.delete(id);
          ctx.rec.streaming.delete(agent.id);
          updateAgent(child, agent.id, { status: "cancelled", error: "Cancelled by user", finished_at: iso(child) });
          outcome = { content: "The person stopped this agent before it finished.", error: true };
          ctx.rec.agentStops.delete(agent.id);
          ctx.rec.activeTools.delete(u.id);
          emit(ctx.rec, { type: "tool.finished", agent_id: parentId, tool_use_id: u.id, is_error: true });
          return { use: u, outcome, t: child.t };
        }
        const message = errorMessage(e);
        updateAgent(child, agent.id, { status: "failed", error: message, finished_at: iso(child) });
        outcome = { content: `Sub-agent failed: ${message}`, error: true };
      }
      ctx.rec.agentStops.delete(agent.id);
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

/** Whether `agentId` works under root `rootId` (it, or a descendant). */
function under(rec: ProjectRecord, agentId: string, rootId: string): boolean {
  const seen = new Set<string>();
  let a = rec.agents.find((x) => x.id === agentId);
  while (a && !seen.has(a.id)) {
    if (a.id === rootId) return true;
    seen.add(a.id);
    const parent = a.parent_id;
    a = parent === null ? undefined : rec.agents.find((x) => x.id === parent);
  }
  return false;
}

/**
 * One orchestrator turn: user prompt, scripted body, then status bookkeeping. It runs in the main session of `ctx.root`
 * (default: the project's default session); turns of different sessions run side by side, each one's events carry its
 * `session_id` (the root's), and a stop or a failure touches only that session's agents.
 */
/** The harness's restart texts (`usererr.TurnInterrupted`): a scripted turn that throws `Interrupted` ends as one a restart cut. */
const RESTARTED = "Octo's local service restarted while this request was running.";
export class Interrupted extends Error {
  constructor() {
    super(RESTARTED);
  }
}

export async function turn(ctx: Ctx, prompt: string, body: (ctx: Ctx, orchestratorId: string) => Promise<void>): Promise<void> {
  const rec = ctx.rec;
  const orch = ctx.root ? agentById(rec, ctx.root) : orchestratorOf(rec);
  const scoped = orch.session_id ? { session_id: orch.session_id } : {};
  (rec.turns ??= new Map()).set(orch.id, ctx.signal);
  if (orch.id === rec.project.orchestrator_agent_id) rec.turn = ctx.signal;
  const asked = addMessage(ctx, orch.id, "user", [{ type: "text", text: prompt }]);
  updateAgent(ctx, orch.id, { status: "running", started_at: iso(ctx), finished_at: null });
  rec.project.status = "running";
  emit(rec, { type: "project.updated", project: clone(rec.project) });

  let status: "completed" | "failed" | "cancelled" = "completed";
  let error: string | null = null;
  let hint: string | undefined;
  let code = "agent_failed";
  let interrupted = false;
  try {
    await body(ctx, orch.id);
  } catch (e) {
    status = e === CANCELLED ? "cancelled" : "failed";
    error = e === CANCELLED ? null : errorMessage(e);
    if (e instanceof Error && "hint" in e && typeof e.hint === "string") hint = e.hint;
    if (e instanceof Error && "code" in e && typeof e.code === "string") code = e.code;
    if (e instanceof Interrupted) {
      interrupted = true;
      code = "turn_interrupted";
    }
    // A cancel happens now; a scripted failure in the past keeps its own time.
    if (status === "cancelled") ctx.t = Math.max(ctx.t, Date.now());
    for (const a of rec.agents) {
      if (a.status === "running" && a.parent_id !== null && under(rec, a.id, orch.id)) {
        updateAgent(ctx, a.id, { status: "cancelled", error: "Cancelled by user", finished_at: iso(ctx) });
      }
    }
    for (const id of [...rec.streaming.keys()]) if (under(rec, id, orch.id)) rec.streaming.delete(id);
    for (const [id, t] of [...rec.activeTools]) if (under(rec, t.agentId, orch.id)) rec.activeTools.delete(id);
  }
  // Like the harness: a failed turn leaves the orchestrator `failed` with its error ("Needs you"); otherwise idle.
  updateAgent(ctx, orch.id, status === "failed" ? { status: "failed", error, finished_at: iso(ctx) } : { status: "idle", error: null, finished_at: iso(ctx) });
  rec.turns.delete(orch.id);
  if (rec.turn === ctx.signal) rec.turn = null;
  (rec.lastStatus ??= new Map()).set(orch.id, status);
  if (rec.turns.size === 0) rec.project.status = "idle";
  // Like the harness: the text written before the end stays (`kept_text`); a restart's hint says which way it went.
  const kept = rec.messages.some((m) => m.agent_id === orch.id && m.role === "assistant" && m.id > asked.id);
  if (interrupted)
    hint = kept
      ? "What it had written before the restart is kept. Retry to run the request again."
      : "Nothing had been written yet. Retry to run the request again.";
  if (orch.id === rec.project.orchestrator_agent_id)
    (rec.endings ??= []).push({
      turn_id: asked.id,
      status: status === "cancelled" ? "stopped" : status,
      started_at: asked.created_at,
      duration_ms: Math.max(0, ctx.t - Date.parse(asked.created_at)),
      ...(status === "failed" && error ? { error: { code, message: error, ...(hint ? { hint } : {}) } } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(status !== "completed" ? { kept_text: kept } : {}),
    });
  touch(ctx);
  emit(rec, { type: "project.updated", project: clone(rec.project) });
  emit(rec, {
    type: "turn.finished",
    status,
    error,
    ...(hint ? { hint } : {}),
    ...(interrupted ? { action: "retry" as const } : {}),
    ...scoped,
    agent_id: orch.id,
  });
  rec.afterTurn?.(orch.id);
}
