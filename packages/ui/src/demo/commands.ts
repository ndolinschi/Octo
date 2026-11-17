import {
  BridgeError,
  type AdhocCommandInput,
  type Bridge,
  type CommandRun,
  type CommandSuggestion,
  type ProjectCommand,
  type ReviewConfig,
  type WorkerProcess,
} from "@octo/agent-client";
import { commandsProblem } from "../lib/commands/config";
import { emit, newId, type ProjectRecord } from "./store";

const LATENCY_MS = 60;
const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
const MAX_RUNNING = 4;

const SEED_COMMANDS: ProjectCommand[] = [
  { name: "Tests", command: "pnpm test", pinned: true },
  { name: "Typecheck", command: "pnpm lint", pinned: true },
  { name: "Dev server", command: "pnpm dev" },
  { name: "Build", command: "pnpm build" },
];

const DEFAULT_REVIEW: ReviewConfig = { commands: ["Tests", "Typecheck", "Build"], mechanical_globs: ["**/*.snap", "docs/generated/"], prefer: "auto" };

const SUGGESTIONS: CommandSuggestion[] = [
  { name: "dev", command: "pnpm run dev", cwd: "", source: "package.json", configured: false },
  { name: "test", command: "pnpm run test", cwd: "", source: "package.json", configured: false },
  { name: "format", command: "pnpm run format", cwd: "", source: "package.json", configured: false },
  { name: "build", command: "make build", cwd: "", source: "Makefile", configured: false },
  { name: "release", command: "just release", cwd: "", source: "justfile", configured: false },
];

type Script = { chunks: { at: number; text: string; stream?: "stdout" | "stderr" }[]; end: number | null; exit: number };

/** What a demo command prints: the dev server never ends by itself, the typecheck fails, the others pass. */
function scriptFor(name: string, command = ""): Script {
  const n = `${name} ${command}`.toLowerCase();
  if (n.includes("dev") || n.includes("serve") || n.includes("watch"))
    return {
      chunks: [
        { at: 220, text: "\n  VITE v6.0.0  ready in 412 ms\n\n" },
        { at: 480, text: "  ➜  Local:   http://localhost:5173/\n" },
        { at: 1200, text: "  [hmr] watching /src for changes\n" },
      ],
      end: null,
      exit: 0,
    };
  if (n.includes("type") || n.includes("lint"))
    return {
      chunks: [
        { at: 200, text: "> atlas-api@1.0.0 lint\n> tsc --noEmit && eslint .\n\n" },
        { at: 900, text: "src/billing/retry.ts(14,7): error TS2322: Type 'number | null' is not assignable to type 'number'.\n", stream: "stderr" },
        {
          at: 1000,
          text: "src/billing/client.ts(9,12): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.\n",
          stream: "stderr",
        },
        { at: 1200, text: "\nFound 2 errors in 2 files.\n", stream: "stderr" },
      ],
      end: 1400,
      exit: 2,
    };
  return {
    chunks: [
      { at: 200, text: `> ${command || "vitest run"}\n\n` },
      { at: 700, text: " ✓ src/billing/errors.test.ts (4)\n" },
      { at: 1200, text: " ✓ src/billing/retry.test.ts (9)\n" },
      { at: 1800, text: " ✓ src/billing/client.test.ts (12)\n" },
      { at: 2400, text: "\n Test Files  3 passed (3)\n      Tests  25 passed (25)\n   Duration  2.3s\n" },
    ],
    end: 2600,
    exit: 0,
  };
}

/** The earlier run shown as history: a failed typecheck with its output. */
const HISTORY_TAIL = `> atlas-api@1.0.0 lint
> tsc --noEmit && eslint .

src/billing/retry.ts(14,7): error TS2322: Type 'number | null' is not assignable to type 'number'.

Found 1 error in 1 file.
`;

const DEV_SERVER_SEED_OUT = `
  VITE v6.0.0  ready in 384 ms

  ➜  Local:   http://localhost:5173/
  [hmr] connected — watching src/
`;

const TESTS_SEED_OUT = `> atlas-api@1.0.0 test
> vitest run

 ✓ src/billing/errors.test.ts (4)
 ✓ src/billing/retry.test.ts (9)
 ✓ src/billing/client.test.ts (12)

 Test Files  3 passed (3)
      Tests  25 passed (25)
   Duration  2.3s
`;

function defaultAdhocName(cmd: string): string {
  const first = cmd.trim().split("\n")[0]?.trim() ?? "Process";
  return first.length > 48 ? `${first.slice(0, 48).trimEnd()}…` : first || "Process";
}

/**
 * Project commands and working processes for the demo bridge: seeded runs, ad-hoc process start, Stop (`SIGTERM`),
 * force-Kill (`SIGKILL`), Restart (spawning a fresh PID), and harness worker subprocesses (language server + agent worker).
 */
export function withDemoCommands(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const runs = new Map<string, { projectId: string; run: CommandRun; output: string; timers: number[] }>();
  const workersByProject = new Map<string, WorkerProcess[]>();
  const seededProjects = new Set<string>();
  const seededReviews = new Set<string>();
  let nextPid = 48250;

  const rec = (pid: string): ProjectRecord => {
    const r = records.get(pid);
    if (!r) throw new BridgeError(404, "not_found", "project not found");
    r.project.commands ??= structuredClone(SEED_COMMANDS);
    r.project.review ??= structuredClone(DEFAULT_REVIEW);
    return r;
  };

  const ensureSeeded = (pid: string) => {
    if (seededProjects.has(pid)) return;
    seededProjects.add(pid);
    const r = rec(pid);
    // Seed active processes only in multi-project demo mode (`?demo=1`), keeping `?demo=one` idle for the zero-animation audit.
    if (records.size <= 1 || r.project.name !== "Atlas API") return;
    const cwd = r.project.folders[0]?.path ?? "/Users/maya/code/atlas-api";
    const now = Date.now();

    const devId = newId("run");
    runs.set(devId, {
      projectId: pid,
      run: {
        id: devId,
        name: "Dev server",
        command: "pnpm dev",
        cwd,
        pid: 48210,
        status: "running",
        exit_code: null,
        started_at: new Date(now - 14 * 60_000).toISOString(),
        duration_ms: 0,
        output_bytes: DEV_SERVER_SEED_OUT.length,
        truncated: false,
      },
      output: DEV_SERVER_SEED_OUT,
      timers: [],
    });

    const testsId = newId("run");
    runs.set(testsId, {
      projectId: pid,
      run: {
        id: testsId,
        name: "Tests",
        command: "pnpm test",
        cwd,
        status: "finished",
        exit_code: 0,
        started_at: new Date(now - 26 * 60_000).toISOString(),
        finished_at: new Date(now - 26 * 60_000 + 2300).toISOString(),
        duration_ms: 2300,
        output_bytes: TESTS_SEED_OUT.length,
        truncated: false,
      },
      output: TESTS_SEED_OUT,
      timers: [],
    });

    workersByProject.set(pid, [
      {
        id: "lsp:typescript-language-server",
        kind: "lsp",
        name: "typescript-language-server",
        command: "typescript-language-server --stdio",
        cwd,
        pid: 47902,
        status: "idle",
        started_at: new Date(now - 28 * 60_000).toISOString(),
        detail: "Language server",
        output: `[tsserver] Loaded ${cwd}/tsconfig.json (42 files)\n`,
      },
      {
        id: "acp:s_atlas",
        kind: "agent",
        name: "claude-code",
        command: "claude --acp --stdio",
        cwd,
        pid: 47815,
        status: "idle",
        started_at: new Date(now - 29 * 60_000).toISOString(),
        detail: "claude-sonnet-4-5",
        output: "[acp] Session ready on stdio transport\n",
      },
    ]);
  };

  const finish = (id: string, status: CommandRun["status"], exit: number, pid: string) => {
    const entry = runs.get(id);
    if (entry?.run.status !== "running") return;
    entry.timers.forEach((t) => window.clearTimeout(t));
    const ms = Math.max(1, Date.now() - Date.parse(entry.run.started_at));
    const { pid: _oldPid, ...rest } = entry.run;
    void _oldPid;
    entry.run = { ...rest, status, exit_code: exit, duration_ms: ms, finished_at: new Date().toISOString() };
    emit(rec(pid), {
      type: "command.finished",
      run_id: id,
      exit_code: exit,
      duration_ms: ms,
      status,
      name: entry.run.name,
      ...(entry.run.review_id ? { review_id: entry.run.review_id } : {}),
    });
  };

  const spawnDemoRun = (pid: string, spec: { name: string; command: string; cwd: string; reviewId?: string }): { run_id: string; run: CommandRun } => {
    const r = rec(pid);
    const activeCount = [...runs.values()].filter((x) => x.projectId === pid && x.run.status === "running").length;
    if (activeCount >= MAX_RUNNING) throw new BridgeError(409, "too_many_runs", `${MAX_RUNNING} commands are running; stop one first`);
    const id = newId("run");
    const osPid = (nextPid += 17);
    const run: CommandRun = {
      id,
      name: spec.name,
      command: spec.command,
      cwd: spec.cwd,
      ...(spec.reviewId ? { review_id: spec.reviewId } : {}),
      pid: osPid,
      status: "running",
      exit_code: null,
      started_at: new Date().toISOString(),
      duration_ms: 0,
      output_bytes: 0,
      truncated: false,
    };
    const entry = { projectId: pid, run, output: "", timers: [] as number[] };
    runs.set(id, entry);
    emit(r, { type: "command.started", run: structuredClone(run) });
    const script = scriptFor(spec.name, spec.command);
    for (const c of script.chunks)
      entry.timers.push(
        window.setTimeout(() => {
          entry.output += c.text;
          entry.run.output_bytes = entry.output.length;
          emit(r, { type: "command.output", run_id: id, stream: c.stream ?? "stdout", text: c.text });
        }, c.at),
      );
    if (script.end !== null) entry.timers.push(window.setTimeout(() => finish(id, "finished", script.exit, pid), script.end));
    return { run_id: id, run: structuredClone(run) };
  };

  const seedHistory = (pid: string, reviewId: string) => {
    if (seededReviews.has(reviewId)) return;
    seededReviews.add(reviewId);
    const id = newId("run");
    const started = Date.now() - 40 * 60_000;
    runs.set(id, {
      projectId: pid,
      run: {
        id,
        name: "Typecheck",
        command: "pnpm lint",
        cwd: "/home/you/.octo/projects/demo/review/x",
        review_id: reviewId,
        status: "finished",
        exit_code: 1,
        started_at: new Date(started).toISOString(),
        finished_at: new Date(started + 5200).toISOString(),
        duration_ms: 5200,
        output_bytes: HISTORY_TAIL.length,
        truncated: false,
      },
      output: HISTORY_TAIL,
      timers: [],
    });
  };

  const view = (r: CommandRun, withTail: boolean, output: string): CommandRun => ({ ...r, ...(withTail ? { tail: output.slice(-65_536) } : {}) });

  return {
    ...base,
    getProject: async (id) => {
      rec(id);
      return base.getProject(id);
    },
    updateProject: async (id, patch) => {
      const r = rec(id);
      if (patch.commands) {
        const problem = commandsProblem(patch.commands);
        if (problem) throw new BridgeError(400, "invalid_request", problem);
        r.project.commands = structuredClone(patch.commands);
      }
      if (patch.review) r.project.review = { ...(r.project.review ?? DEFAULT_REVIEW), ...structuredClone(patch.review) };
      return base.updateProject(id, patch);
    },
    listCommandSuggestions: async (pid) => {
      await delay();
      const names = new Set((rec(pid).project.commands ?? []).map((c) => c.name.toLowerCase()));
      return SUGGESTIONS.map((s) => ({ ...s, configured: names.has(s.name.toLowerCase()) }));
    },
    runCommand: async (pid, name, options) => {
      await delay();
      ensureSeeded(pid);
      const r = rec(pid);
      const cmd = (r.project.commands ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!cmd) throw new BridgeError(404, "command_not_found", `no command named ${name}`);
      const baseCwd = r.project.folders[0]?.path ?? "/home/you/atlas-api";
      return spawnDemoRun(pid, {
        name: cmd.name,
        command: cmd.command,
        cwd: options?.reviewId ? "/home/you/.octo/projects/demo/review/x" : cmd.cwd ? `${baseCwd}/${cmd.cwd}` : baseCwd,
        ...(options?.reviewId ? { reviewId: options.reviewId } : {}),
      });
    },
    startCommandRun: async (pid, input: AdhocCommandInput) => {
      await delay();
      ensureSeeded(pid);
      const r = rec(pid);
      const command = input.command.trim();
      if (!command) throw new BridgeError(400, "invalid_request", "Command line cannot be empty");
      const baseCwd = r.project.folders[0]?.path ?? "/home/you/atlas-api";
      const name = input.name?.trim() || defaultAdhocName(command);
      const cwd = input.cwd?.trim() ? (input.cwd.trim().startsWith("/") ? input.cwd.trim() : `${baseCwd}/${input.cwd.trim()}`) : baseCwd;
      return spawnDemoRun(pid, { name, command, cwd });
    },
    listCommandRuns: async (pid, options) => {
      await delay();
      ensureSeeded(pid);
      if (options?.reviewId) seedHistory(pid, options.reviewId);
      return [...runs.values()]
        .filter((x) => x.projectId === pid && (options?.reviewId ? x.run.review_id === options.reviewId : x.run.review_id === undefined))
        .sort((a, b) => Date.parse(b.run.started_at) - Date.parse(a.run.started_at))
        .slice(0, options?.limit ?? 100)
        .map((x) => view(x.run, false, ""));
    },
    getCommandRun: async (pid, runId) => {
      await delay();
      ensureSeeded(pid);
      const x = runs.get(runId);
      if (!x || x.projectId !== pid) throw new BridgeError(404, "not_found", "run not found");
      return view(x.run, true, x.output);
    },
    stopCommandRun: async (pid, runId, options) => {
      await delay();
      ensureSeeded(pid);
      const x = runs.get(runId);
      if (!x || x.projectId !== pid) throw new BridgeError(404, "not_found", "run not found");
      finish(runId, "stopped", options?.force ? -9 : -1, pid);
      return view(x.run, false, "");
    },
    restartCommandRun: async (pid, runId) => {
      await delay();
      ensureSeeded(pid);
      const x = runs.get(runId);
      if (!x || x.projectId !== pid) throw new BridgeError(404, "not_found", "run not found");
      if (x.run.status === "running") finish(runId, "stopped", -1, pid);
      return spawnDemoRun(pid, {
        name: x.run.name,
        command: x.run.command,
        cwd: x.run.cwd,
        ...(x.run.review_id ? { reviewId: x.run.review_id } : {}),
      });
    },
    listWorkerProcesses: async (pid) => {
      await delay();
      ensureSeeded(pid);
      return structuredClone(workersByProject.get(pid) ?? []);
    },
    stopWorkerProcess: async (pid, procId) => {
      await delay();
      ensureSeeded(pid);
      const list = workersByProject.get(pid) ?? [];
      const idx = list.findIndex((w) => w.id === procId);
      if (idx < 0) throw new BridgeError(404, "not_found", "worker process not found");
      list.splice(idx, 1);
      workersByProject.set(pid, list);
    },
    restartWorkerProcess: async (pid, procId) => {
      await delay();
      ensureSeeded(pid);
      const list = workersByProject.get(pid) ?? [];
      const w = list.find((item) => item.id === procId);
      if (!w) throw new BridgeError(404, "not_found", "worker process not found");
      nextPid += 19;
      w.pid = nextPid;
      w.status = w.kind === "lsp" ? "running" : "idle";
      w.started_at = new Date().toISOString();
      w.output = `${w.output ?? ""}[restarted] Spawned PID ${w.pid}\n`;
      return structuredClone(w);
    },
  };
}
