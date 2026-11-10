import { BridgeError, type Agent, type Bridge, type Models, type Note, type Project, type ProjectInput, type ProjectSummary } from "@octo/agent-client";
import { basename } from "../lib/format";
import { atlasHistory } from "./atlas";
import { backgroundTurn, docsHistory } from "./extra";
import { ensureSeeded, listDemoFiles, readDemoFile, writeDemo } from "./files";
import { genericTurn } from "./generic";
import { infraAcpTurn, ledgerShowcase, pastHistory } from "./history";
import { demoLanguageServers, demoPlugins } from "./plugins";
import { orbitLive } from "./orbit";
import { manyProjectNames, requestsHistory, stressHistory } from "./stress";
import type { Ctx } from "./runtime";
import { clone, emit, newId, orchestratorOf, type ProjectRecord } from "./store";

/** full: the regular demo (plus a Stress test project) · empty: no projects · one: a single project ·
 *  many: 30 projects with short, typical and 120+ character names (0, 1 and 30 requests in the first three). */
export type DemoSeed = "full" | "empty" | "one" | "many";

/** How the demo language servers behave: ok · fail-once (first start of each server fails, Retry works) ·
 *  slow (3s to start) · exit (crashes 4s after starting). */
export type DemoLsp = "ok" | "fail-once" | "slow" | "exit";

export type DemoOptions = { seed?: DemoSeed; lsp?: DemoLsp; plugins?: boolean };

/** Demo-only trace of calls a scripted check wants to observe (console.debug, never shown). */
function trace(event: string, detail: unknown): void {
  console.debug(`[octo demo] ${event}`, typeof detail === "string" ? detail : JSON.stringify(detail));
}

const DEFAULT_MODELS: Models = {
  orchestrator: "claude-opus-5-5",
  fast: "claude-haiku-5-5",
  balanced: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
};

const HOUR = 3600_000;
const LATENCY_MS = 60;

function makeProject(input: ProjectInput, createdAt: number): ProjectRecord {
  const id = newId("prj");
  const at = new Date(createdAt).toISOString();
  const orchestrator: Agent = {
    id: newId("agt"),
    project_id: id,
    parent_id: null,
    depth: 0,
    role: "orchestrator",
    title: "",
    task: "",
    model: input.models?.orchestrator ?? DEFAULT_MODELS.orchestrator,
    tier: null,
    status: "idle",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: at,
    started_at: null,
    finished_at: null,
  };
  const folders = dedupeFolders(input.folders ?? []);
  const rec: ProjectRecord = {
    project: {
      id,
      name: input.name,
      description: input.description ?? "",
      status: "idle",
      folder_count: folders.length,
      agent_count: 1,
      created_at: at,
      updated_at: at,
      instructions: input.instructions ?? "",
      folders,
      models: { ...DEFAULT_MODELS, ...input.models },
      max_depth: input.max_depth ?? 3,
      orchestrator_agent_id: orchestrator.id,
    },
    agents: [orchestrator],
    messages: [],
    notes: [],
    streaming: new Map(),
    activeTools: new Map(),
    listeners: new Set(),
    seq: 0,
    nextMessageId: 1,
    turn: null,
    files: new Map(),
    seeded: new Set(),
  };
  return rec;
}

function dedupeFolders(folders: { path: string; label?: string }[]): Project["folders"] {
  const used = new Set<string>();
  return folders.map((f) => {
    const base = f.label?.trim() || basename(f.path);
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base}-${n}`;
    used.add(label);
    return { id: newId("fld"), label, path: f.path };
  });
}

function userNote(title: string, content: string, at: number): Note {
  const iso = new Date(at).toISOString();
  return { id: newId("note"), title, content, author: "user", created_at: iso, updated_at: iso };
}

function startScript(rec: ProjectRecord, t: number, script: (ctx: Ctx) => Promise<void>): void {
  void script({ rec, t, signal: { cancelled: false } });
}

function seed(): ProjectRecord[] {
  const now = Date.now();
  const atlas = makeProject(
    {
      name: "Atlas API",
      description: "Accounts + billing service and its web dashboard",
      instructions: "Prefer small, reviewable changes. Never edit migrations without asking. Every fix needs a test that failed first.",
      folders: [
        { path: "/Users/maya/code/atlas-api", label: "atlas-api" },
        { path: "/Users/maya/code/atlas-web", label: "atlas-web" },
      ],
    },
    now - 30 * HOUR,
  );
  atlas.notes.push(
    userNote("Deploy constraints", "No deploys on Fridays. Staging is `atlas-stg` and needs the VPN. Ask before touching `src/billing/`.", now - 29 * HOUR),
  );
  startScript(atlas, now - 28 * HOUR, atlasHistory);

  const orbit = makeProject(
    {
      name: "Orbit mobile",
      description: "iOS + Android client (React Native)",
      instructions: "Keep the old-architecture interop until native-camera is rewritten.",
      folders: [{ path: "/Users/maya/code/orbit-app", label: "orbit-app" }],
    },
    now - 5 * 24 * HOUR,
  );
  startScript(orbit, now - 6_000, orbitLive);

  const docs = makeProject(
    {
      name: "Docs site",
      description: "Marketing site and docs (Astro)",
      folders: [{ path: "/Users/maya/code/docs-site" }],
    },
    now - 10 * HOUR,
  );
  startScript(docs, now - 9 * HOUR, docsHistory);

  const payments = makeProject(
    {
      name: "Payments ledger reconciliation and nightly settlement jobs",
      description: "Settlement batch jobs and the reconciliation report",
      folders: [{ path: "/Users/maya/code/ledger", label: "ledger" }],
    },
    now - 3 * 24 * HOUR,
  );
  startScript(payments, now - 182 * 24 * HOUR, async (ctx) => {
    await pastHistory(ctx, {
      seed: 7,
      turns: 46,
      days: 182,
      roles: ["Implementer", "Test writer", "Reviewer", "Code explorer"],
      files: ["jobs/reconcile.ts", "jobs/payouts.ts", "reports/uk.sql", "test/settle.test.ts", "lib/money.ts", "lib/types.ts"],
      prompts: [
        "Add the UK region to the nightly settlement.",
        "The reconciliation report is missing refunds; find out why.",
        "Speed up the settlement query for merchants with many lines.",
        "Write a test for the month-end cut-over.",
        "Review last week's changes to money.ts.",
        "Export the EU totals as CSV for finance.",
        "Retry failed payouts once with backoff.",
      ],
    });
    ctx.t = Math.max(ctx.t, now - 26 * HOUR);
    await ledgerShowcase(ctx);
    ctx.t = Math.max(ctx.t, now - 1_200);
    await backgroundTurn(
      "Re-run last night's settlement for the EU merchants and tell me if the totals match.",
      {
        name: "bash",
        input: { command: "pnpm settle --region eu --date yesterday --dry-run" },
        result: "Settled 1,284 merchants · €2,418,903.17 · 0 mismatches",
      },
      "Re-ran the EU settlement as a dry run: **1,284 merchants, €2,418,903.17**, and the totals match the ledger exactly. Nothing was written.",
      2_600,
    )(ctx);
  });

  const infra = makeProject(
    {
      name: "Infrastructure: Terraform modules for staging and production clusters",
      description: "Shared Terraform modules and environment stacks",
      folders: [{ path: "/Users/maya/code/infra", label: "infra" }],
    },
    now - 6 * 24 * HOUR,
  );
  startScript(infra, now - 180 * 24 * HOUR, async (ctx) => {
    await pastHistory(ctx, {
      seed: 23,
      turns: 34,
      days: 180,
      roles: ["Implementer", "Reviewer", "Planner"],
      files: ["modules/node-pool/variables.tf", "modules/dns/main.tf", "envs/staging/variables.tf", "envs/production/variables.tf", "docs/runbook.md"],
      prompts: [
        "Bump the provider versions and run a plan.",
        "Add a DNS module for the internal zone.",
        "Why does the production plan want to replace the bucket?",
        "Tag every resource with its cost centre.",
        "Split the staging stack into network and compute.",
      ],
    });
    ctx.t = Math.max(ctx.t, now - 3 * HOUR);
    await infraAcpTurn(ctx, "/Users/maya/code/infra");
    ctx.t = Math.max(ctx.t, now - 800);
    await backgroundTurn(
      "Plan the staging upgrade to the new node pool module and summarise the diff.",
      { name: "bash", input: { command: "terraform -chdir=envs/staging plan -no-color" }, result: "Plan: 3 to add, 1 to change, 2 to destroy." },
      "The staging plan adds the new node pool, updates the autoscaler and removes the two old pools: **3 to add, 1 to change, 2 to destroy**. No production resources are touched.",
      4_200,
    )(ctx);
  });

  const tokens = makeProject(
    {
      name: "Design system tokens",
      description: "Colour, type and spacing tokens shared by the web apps",
      folders: [{ path: "/Users/maya/code/tokens", label: "tokens" }],
    },
    now - 2 * 24 * HOUR,
  );
  const stress = makeProject(
    {
      name: "Stress test",
      description: "200 messages, a very long prompt, long file names",
      folders: [{ path: "/Users/maya/code/stress-kit", label: "stress-kit" }],
    },
    now - 40 * 24 * HOUR,
  );
  startScript(stress, now - 30 * HOUR, stressHistory);
  return [orbit, atlas, docs, payments, infra, tokens, stress];
}

function seedMany(): ProjectRecord[] {
  const now = Date.now();
  return manyProjectNames().map((name, i) => {
    const rec = makeProject({ name, folders: [{ path: `/Users/maya/code/p${i}`, label: `p${i}` }] }, now - (i + 1) * 5 * HOUR);
    const count = i === 0 ? 30 : i === 1 ? 1 : 0;
    if (count) startScript(rec, now - 20 * HOUR, requestsHistory(count));
    return rec;
  });
}

function seedOne(): ProjectRecord[] {
  const rec = makeProject({ name: "Atlas API", folders: [{ path: "/Users/maya/code/atlas-api", label: "atlas-api" }] }, Date.now() - 30 * HOUR);
  startScript(rec, Date.now() - 28 * HOUR, atlasHistory);
  return [rec];
}

const SEEDERS: Record<DemoSeed, () => ProjectRecord[]> = { full: seed, empty: () => [], one: seedOne, many: seedMany };

export function createDemoBridge(options: DemoOptions = {}): Bridge {
  const lspMode = options.lsp ?? "ok";
  const pluginsOn = options.plugins ?? true;
  const failedOnce = new Set<string>();
  const records = new Map<string, ProjectRecord>();
  for (const rec of SEEDERS[options.seed ?? "full"]()) records.set(rec.project.id, rec);

  const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
  const get = (id: string) => {
    const rec = records.get(id);
    if (!rec) throw new BridgeError(404, "not_found", "project not found");
    return rec;
  };
  const summary = (p: Project): ProjectSummary => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    folder_count: p.folders.length,
    agent_count: p.agent_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
  });

  return {
    health: async () => (await delay(), { ok: true, version: "demo" }),
    getConfig: async () => (await delay(), { default_models: { ...DEFAULT_MODELS }, default_max_depth: 3 }),
    listProjects: async () => {
      await delay();
      return [...records.values()].map((r) => summary(r.project)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    },
    createProject: async (input) => {
      await delay();
      if (!input.name?.trim()) throw new BridgeError(400, "invalid", "name is required");
      const rec = makeProject(input, Date.now());
      records.set(rec.project.id, rec);
      return clone(rec.project);
    },
    getProject: async (id) => (await delay(), clone(get(id).project)),
    updateProject: async (id, patch) => {
      await delay();
      const rec = get(id);
      const p = rec.project;
      if (patch.name !== undefined) p.name = patch.name;
      if (patch.description !== undefined) p.description = patch.description;
      if (patch.instructions !== undefined) p.instructions = patch.instructions;
      if (patch.max_depth !== undefined) p.max_depth = patch.max_depth;
      if (patch.models) p.models = { ...p.models, ...patch.models };
      if (patch.folders) p.folders = dedupeFolders(patch.folders);
      p.folder_count = p.folders.length;
      p.updated_at = new Date().toISOString();
      emit(rec, { type: "project.updated", project: clone(p) });
      return clone(p);
    },
    deleteProject: async (id) => {
      await delay();
      if (get(id).turn) throw new BridgeError(409, "turn_in_progress", "stop the running turn before deleting");
      records.delete(id);
    },
    listAgents: async (id) => (await delay(), clone(get(id).agents)),
    getAgent: async (id, agentId) => {
      await delay();
      const agent = get(id).agents.find((a) => a.id === agentId);
      if (!agent) throw new BridgeError(404, "not_found", "agent not found");
      return clone(agent);
    },
    listMessages: async (id, agentId) => (await delay(), clone(get(id).messages.filter((m) => m.agent_id === agentId))),
    sendMessage: async (id, text) => {
      await delay();
      const rec = get(id);
      if (rec.turn) throw new BridgeError(409, "turn_in_progress", "a turn is already running");
      trace("sendMessage", text);
      startScript(rec, Date.now(), (ctx) => genericTurn(ctx, text));
      const orch = orchestratorOf(rec);
      const sent = [...rec.messages].reverse().find((m) => m.agent_id === orch.id && m.role === "user");
      if (!sent) throw new BridgeError(500, "internal", "message not recorded");
      return clone(sent);
    },
    cancelTurn: async (id) => {
      await delay();
      const rec = get(id);
      if (rec.turn) rec.turn.cancelled = true;
    },
    listNotes: async (id) => (await delay(), clone(get(id).notes)),
    createNote: async (id, input) => {
      await delay();
      const rec = get(id);
      const note = userNote(input.title, input.content, Date.now());
      rec.notes.push(note);
      emit(rec, { type: "note.changed", note: clone(note), note_id: note.id });
      return clone(note);
    },
    updateNote: async (id, noteId, patch) => {
      await delay();
      const rec = get(id);
      const note = rec.notes.find((n) => n.id === noteId);
      if (!note) throw new BridgeError(404, "not_found", "note not found");
      Object.assign(note, patch, { updated_at: new Date().toISOString() });
      emit(rec, { type: "note.changed", note: clone(note), note_id: note.id });
      return clone(note);
    },
    deleteNote: async (id, noteId) => {
      await delay();
      const rec = get(id);
      rec.notes = rec.notes.filter((n) => n.id !== noteId);
      emit(rec, { type: "note.changed", note: null, note_id: noteId });
    },
    listFiles: async (id, folder, path) => {
      await delay();
      await ensureSeeded(get(id));
      return listDemoFiles(get(id), folder, path);
    },
    readFile: async (id, folder, path) => {
      await delay();
      await ensureSeeded(get(id));
      return readDemoFile(get(id), folder, path);
    },
    writeFile: async (id, input) => {
      await delay();
      await ensureSeeded(get(id));
      return writeDemo(get(id), input);
    },
    listPlugins: async () => (await delay(), demoPlugins(pluginsOn)),
    // Usage and limits load with the Usage tab / Home (their own chunk).
    getUsage: async (params) => {
      await delay();
      const { demoUsage } = await import("./usage");
      return demoUsage(records.values(), params, Date.now());
    },
    getLimits: async () => {
      await delay();
      const { demoLimits } = await import("./usage");
      return demoLimits(Date.now());
    },
    listLanguageServers: async (id) => (await delay(), get(id), demoLanguageServers(pluginsOn)),
    openLanguageServer: async (id, serverId) => {
      await delay();
      const rec = get(id);
      const info = demoLanguageServers(pluginsOn).find((s) => s.id === serverId);
      if (!info) throw new BridgeError(404, "not_found", "language server not found");
      if (!info.available) throw new BridgeError(409, "unavailable", `${info.label} is not installed on this machine`);
      const once = `${id}/${serverId}`;
      if (lspMode === "fail-once" && !failedOnce.has(once)) {
        failedOnce.add(once);
        throw new BridgeError(500, "spawn_failed", `${info.label} exited during startup (exit status 1)`);
      }
      await ensureSeeded(rec);
      const { createDemoServer } = await import("./lsp");
      const session = createDemoServer(rec, {
        serverId,
        startMs: lspMode === "slow" ? 3_000 : 80,
        exitAfterMs: lspMode === "exit" ? 4_000 : null,
      });
      trace("lsp open", serverId);
      const close = session.close;
      return { ...session, close: () => (trace("lsp close", serverId), close()) };
    },
    subscribe(id, handlers) {
      const rec = records.get(id);
      if (!rec) {
        setTimeout(() => handlers.onError?.(new BridgeError(404, "not_found", "project not found")), 0);
        return () => undefined;
      }
      let active = true;
      setTimeout(() => {
        if (!active) return;
        rec.listeners.add(handlers);
        handlers.onOpen?.();
        const seq = rec.seq;
        for (const [agentId, text] of rec.streaming) handlers.onEvent({ type: "message.delta", seq, agent_id: agentId, text });
        for (const [toolUseId, t] of rec.activeTools) {
          handlers.onEvent({ type: "tool.started", seq, agent_id: t.agentId, tool_use_id: toolUseId, name: t.name });
        }
      }, LATENCY_MS);
      return () => {
        active = false;
        rec.listeners.delete(handlers);
      };
    },
  };
}
