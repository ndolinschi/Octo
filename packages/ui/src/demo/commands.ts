import { BridgeError, type Bridge, type CommandRun, type CommandSuggestion, type ProjectCommand, type ReviewConfig } from "@octo/agent-client";
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
function scriptFor(name: string): Script {
  const n = name.toLowerCase();
  if (n.includes("dev"))
    return {
      chunks: [
        { at: 300, text: "\n  VITE v6.0.0  ready in 412 ms\n\n" },
        { at: 700, text: "  ➜  Local:   http://localhost:5173/\n" },
        { at: 1500, text: "  [hmr] updated /src/billing/retry.ts\n" },
        { at: 4000, text: "  [hmr] updated /src/billing/client.ts\n" },
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
      { at: 200, text: "> atlas-api@1.0.0 test\n> vitest run\n\n" },
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

/**
 * Project commands (decision 68) for the demo bridge: a seeded list and review configuration that `updateProject` edits with
 * the harness's validation, suggestions, and runs that stream `command.*` events on timers (a dev server that runs until
 * stopped, a typecheck that fails, tests that pass). Nothing is executed.
 */
export function withDemoCommands(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const runs = new Map<string, { run: CommandRun; output: string; timers: number[] }>();
  const seededReviews = new Set<string>();

  const rec = (pid: string): ProjectRecord => {
    const r = records.get(pid);
    if (!r) throw new BridgeError(404, "not_found", "project not found");
    r.project.commands ??= structuredClone(SEED_COMMANDS);
    r.project.review ??= structuredClone(DEFAULT_REVIEW);
    return r;
  };

  const finish = (id: string, status: CommandRun["status"], exit: number, pid: string) => {
    const entry = runs.get(id);
    if (entry?.run.status !== "running") return;
    entry.timers.forEach((t) => window.clearTimeout(t));
    const ms = Date.now() - Date.parse(entry.run.started_at);
    entry.run = { ...entry.run, status, exit_code: exit, duration_ms: ms, finished_at: new Date().toISOString() };
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

  const seedHistory = (pid: string, reviewId: string) => {
    if (seededReviews.has(reviewId)) return;
    seededReviews.add(reviewId);
    const id = newId("run");
    const started = Date.now() - 40 * 60_000;
    runs.set(id, {
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
    void pid;
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
      const r = rec(pid);
      const cmd = (r.project.commands ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!cmd) throw new BridgeError(404, "command_not_found", `no command named ${name}`);
      if ([...runs.values()].filter((x) => x.run.status === "running").length >= MAX_RUNNING)
        throw new BridgeError(409, "too_many_runs", `${MAX_RUNNING} commands are running; stop one first`);
      const id = newId("run");
      const run: CommandRun = {
        id,
        name: cmd.name,
        command: cmd.command,
        cwd: options?.reviewId ? "/home/you/.octo/projects/demo/review/x" : "/home/you/atlas-api",
        ...(options?.reviewId ? { review_id: options.reviewId } : {}),
        status: "running",
        exit_code: null,
        started_at: new Date().toISOString(),
        duration_ms: 0,
        output_bytes: 0,
        truncated: false,
      };
      const entry = { run, output: "", timers: [] as number[] };
      runs.set(id, entry);
      emit(r, { type: "command.started", run: structuredClone(run) });
      const script = scriptFor(cmd.name);
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
    },
    listCommandRuns: async (pid, options) => {
      await delay();
      if (options?.reviewId) seedHistory(pid, options.reviewId);
      return [...runs.values()]
        .filter((x) => (options?.reviewId ? x.run.review_id === options.reviewId : true))
        .sort((a, b) => Date.parse(b.run.started_at) - Date.parse(a.run.started_at))
        .slice(0, options?.limit ?? 100)
        .map((x) => view(x.run, false, ""));
    },
    getCommandRun: async (_pid, runId) => {
      await delay();
      const x = runs.get(runId);
      if (!x) throw new BridgeError(404, "not_found", "run not found");
      return view(x.run, true, x.output);
    },
    stopCommandRun: async (pid, runId) => {
      await delay();
      const x = runs.get(runId);
      if (!x) throw new BridgeError(404, "not_found", "run not found");
      finish(runId, "stopped", -1, pid);
      return view(x.run, false, "");
    },
  };
}
