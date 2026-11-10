import {
  BridgeError,
  type Agent,
  type Bridge,
  type Models,
  type Note,
  type Project,
  type ProjectInput,
  type ProjectSummary,
} from "@octo/agent-client";
import { basename } from "../lib/format";
import { atlasHistory } from "./atlas";
import { ensureSeeded, listDemoFiles, readDemoFile, writeDemo } from "./files";
import { genericTurn } from "./generic";
import { orbitLive } from "./orbit";
import type { Ctx } from "./runtime";
import { clone, emit, newId, orchestratorOf, type ProjectRecord } from "./store";

export type DemoSeed = "full" | "empty";

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
  atlas.notes.push(userNote("Deploy constraints", "No deploys on Fridays. Staging is `atlas-stg` and needs the VPN. Ask before touching `src/billing/`.", now - 29 * HOUR));
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
    now - 3 * HOUR,
  );
  return [orbit, atlas, docs];
}

export function createDemoBridge(options: { seed?: DemoSeed } = {}): Bridge {
  const records = new Map<string, ProjectRecord>();
  for (const rec of options.seed === "empty" ? [] : seed()) records.set(rec.project.id, rec);

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
      return [...records.values()]
        .map((r) => summary(r.project))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
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
