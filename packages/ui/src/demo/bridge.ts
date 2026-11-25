import { createDemoRemote } from "./remote";
import {
  APPROVAL_TRIGGER,
  FAIL_TRIGGER,
  LIVE_TRIGGER,
  SLOW_TRIGGER,
  SPAWN_REFUSED_TRIGGER,
  STUBBORN_TRIGGER,
  approvalTurn,
  failTurn,
  liveTurn,
  slowTurn,
  spawnRefusedTurn,
  stubbornTurn,
} from "./live";
import { RUN_CARDS_TRIGGER, runCardsTurn } from "./runCards";
import {
  BridgeError,
  type Agent,
  type Bridge,
  type Models,
  type Project,
  type ProjectInput,
  type ProjectSummary,
  type SideMessage,
  type CompactionMarker,
  type FileBytesReader,
} from "@octo/agent-client";
import { basename } from "../lib/format";
import { atlasHistory } from "./atlas";
import { backgroundTurn, docsHistory } from "./extra";
import { deleteDemo, ensureSeeded, listDemoFiles, mkdirDemo, readDemoFile, readDemoFileBytes, renameDemo, searchDemoFiles, writeDemo } from "./files";
import { genericTurn } from "./generic";
import { infraAcpTurn, ledgerShowcase, pastHistory } from "./history";
import { demoLanguageServers, demoPlugins } from "./plugins";
import { demoProviders } from "./providers";
import { createDemoNote, docOf, listed, patchDemoNote, seedNotes } from "./notes";
import { orbitLive } from "./orbit";
import { withDemoCommands } from "./commands";
import { withDemoTerminals } from "./terminal";
import { withDemoSessions } from "./sessions";
import { withDemoBranches } from "./branches";
import { sideModeFromUrl, withDemoSide } from "./side";
import { withDemoReview } from "./review";
import { withDemoParity } from "./parity";
import { withDemoV7 } from "./v7";
import { withDemoSlash } from "./slash";
import { manyProjectNames, requestsHistory, stressHistory } from "./stress";
import { seedTourState } from "./tour";
import { acpOrchestratorHistory, routeAgents, tablesTurn } from "./routed";
import { act, Interrupted, say, sleep, turn, type Ctx } from "./runtime";
import { clone, emit, newId, orchestratorOf, type ProjectRecord } from "./store";

/** full: the regular demo (plus a Stress test project) · empty: no projects · one: a single project ·
 *  many: 30 projects with short, typical and 120+ character names (0, 1 and 30 requests in the first three). */
export type DemoSeed = "full" | "empty" | "one" | "many";

/** How the demo language servers behave: ok · fail-once (first start of each server fails, Retry works) ·
 *  slow (3s to start) · exit (crashes 4s after starting). */
export type DemoLsp = "ok" | "fail-once" | "slow" | "exit";

/** `nokey`: no API key and no router — the built-in loop is unavailable, only ACP agents can run (also `?nokey=1`). */
export type DemoOptions = { seed?: DemoSeed; lsp?: DemoLsp; plugins?: boolean; nokey?: boolean };

/** Demo-only trace of calls a scripted check wants to observe (console.debug, never shown). */
function trace(event: string, detail: unknown): void {
  console.debug(`[octo demo] ${event}`, typeof detail === "string" ? detail : JSON.stringify(detail));
}

/** The harness's built-in tiers (`config.DefaultModels`): new projects plan on the balanced tier. */
const claudeLoggedOut = (): boolean => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("claude") === "loggedout";

const DEFAULT_MODELS: Models = {
  orchestrator: "claude-sonnet-5-5",
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
      access: input.access ?? "supervised",
      memory: { context: "full", recent_exchanges: 5, auto_memory: "off", ...input.memory },
      orchestrator_agent_id: orchestrator.id,
      ...(input.budget_usd ? { budget_usd: input.budget_usd, spent_usd: 0 } : {}),
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

function startScript(rec: ProjectRecord, t: number, script: (ctx: Ctx) => Promise<void>, root?: string): void {
  void script({ rec, t, signal: { cancelled: false }, ...(root ? { root } : {}) });
}

/** The scripted turn a message starts (the demo triggers: fail, live, spawn refused, slow, approval, stubborn, else generic). */
function scriptFor(text: string): (ctx: Ctx) => Promise<void> {
  return (ctx) =>
    FAIL_TRIGGER.test(text)
      ? failTurn(ctx, text)
      : RUN_CARDS_TRIGGER.test(text)
        ? runCardsTurn(ctx, text)
        : LIVE_TRIGGER.test(text)
          ? liveTurn(ctx, text)
          : SPAWN_REFUSED_TRIGGER.test(text)
            ? spawnRefusedTurn(ctx, text)
            : SLOW_TRIGGER.test(text)
              ? slowTurn(ctx, text)
              : APPROVAL_TRIGGER.test(text)
                ? approvalTurn(ctx, text)
                : STUBBORN_TRIGGER.test(text)
                  ? stubbornTurn(ctx, text)
                  : genericTurn(ctx, text);
}

function seed(): ProjectRecord[] {
  const now = Date.now();
  const atlas = makeProject(
    {
      name: "Atlas API",
      // Deliberately on Opus, through Claude Code (the ready agent): the normal look of a chip. Projects on the API model show the warning.
      models: { orchestrator: "acp:claude-code/claude-opus-5-5" },
      description: "Accounts + billing service and its web dashboard",
      instructions: "Prefer small, reviewable changes. Never edit migrations without asking. Every fix needs a test that failed first.",
      folders: [
        { path: "/Users/maya/code/atlas-api", label: "atlas-api" },
        { path: "/Users/maya/code/atlas-web", label: "atlas-web" },
      ],
    },
    now - 30 * HOUR,
  );
  atlas.notes.push(...seedNotes(now));
  startScript(atlas, now - 28 * HOUR, atlasHistory);

  const orbit = makeProject(
    {
      name: "Orbit mobile",
      // Deliberately on Opus, through Claude Code (the ready agent): the normal look of a chip. Projects on the API model show the warning.
      models: { orchestrator: "acp:claude-code/claude-opus-5-5" },
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
  // Behind a router (decision 37): a budget at 86% (amber), the Ceiling policy, and models served other than asked for.
  docs.project.budget_usd = 25;
  docs.project.spent_usd = 21.4;
  docs.project.models.tier_policy = "ceiling";
  startScript(docs, now - 9 * HOUR, async (ctx) => {
    await docsHistory(ctx);
    ctx.t = Math.max(ctx.t, now - 50 * 60_000);
    await tablesTurn(ctx);
    routeAgents(ctx.rec, "deepseek/deepseek-v4.1-flash");
  });

  const payments = makeProject(
    {
      name: "Payments ledger reconciliation and nightly settlement jobs",
      // Deliberately on Opus, through Claude Code (the ready agent): the normal look of a chip. Projects on the API model show the warning.
      models: { orchestrator: "acp:claude-code/claude-opus-5-5" },
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
    routeAgents(ctx.rec, "claude-opus-5-5");
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
      // Deliberately on Opus, through Claude Code (the ready agent): the normal look of a chip. Projects on the API model show the warning.
      models: { orchestrator: "acp:claude-code/claude-opus-5-5" },
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

  // A turn that failed (the provider gave up): the "Needs you" state.
  const webhooks = makeProject(
    {
      name: "Billing webhooks",
      description: "Stripe webhook handler and its retry queue",
      folders: [{ path: "/Users/maya/code/webhooks", label: "webhooks" }],
    },
    now - 4 * 24 * HOUR,
  );
  startScript(webhooks, now - 30 * HOUR, async (ctx) => {
    await turn(ctx, "List the webhook events we handle and which ones we ignore.", async (c, orch) => {
      await act(c, orch, [{ name: "grep", input: { pattern: 'case "', path: "src/handler.ts" }, result: "14 matches", ms: 500 }]);
      await say(c, orch, "We handle 14 event types; `charge.dispute.*` and `payout.*` fall through to the default branch and are ignored.");
    });
    await sleep(ctx, 40 * 60_000);
    // NEW-1: earlier failed turns keep their reason after a reload: the harness stores each failure (code, message, hint)
    // with its exchange. Two turns a restart cut (item 7): one had written text (kept), one had not.
    await turn(ctx, "Which events are stuck in the retry queue?", async (c, orch) => {
      await act(c, orch, [
        {
          name: "bash",
          input: { command: "pnpm queue:inspect --stuck" },
          result: "Redis at 127.0.0.1:6379 is not running. Start it with `docker compose up redis`, then ask again.",
          ms: 600,
          error: true,
        },
      ]);
      throw new Error("Redis at 127.0.0.1:6379 is not running.");
    });
    await sleep(ctx, 5 * 60_000);
    await turn(ctx, "Draft a reply to the ticket about duplicate charges.", async (c, orch) => {
      await say(c, orch, "Reading the ticket and the two charges it mentions…");
      throw Object.assign(new Error("The model did not answer."), {
        code: "model_call_failed",
        hint: "Try again. If it keeps happening, check the provider in Settings.",
      });
    });
    await sleep(ctx, 6 * 60_000);
    await turn(ctx, "Summarise the refunds issued last week.", async (c, orch) => {
      await say(c, orch, "Last week's refunds so far: 12 issued, 3 of them partial; the largest was €480 for a duplicate annual plan.");
      throw new Interrupted();
    });
    await sleep(ctx, 4 * 60_000);
    await turn(ctx, "Check whether the retry queue drops events after 24 hours.", async () => {
      await Promise.resolve();
      throw new Interrupted();
    });
    await sleep(ctx, 10 * 60_000);
    await turn(ctx, "Replay yesterday's failed webhooks against staging.", async (c, orch) => {
      await act(c, orch, [
        {
          name: "bash",
          input: { command: "pnpm replay --since yesterday --target staging" },
          result: "error: staging rejected the signing secret (401)",
          ms: 900,
          error: true,
        },
      ]);
      throw new Error("Staging rejected the webhook signing secret (401). Rotate STAGING_WEBHOOK_SECRET, then ask again.");
    });
  });

  // The budget is spent: the header turns red ("Project budget reached").
  webhooks.project.budget_usd = 10;
  webhooks.project.spent_usd = 10.42;

  // An orchestrator that runs as an ACP agent (Claude Code on a subscription), with the harness's MCP warning.
  const release = makeProject(
    {
      name: "Release notes",
      description: "Changelog and release notes for the public API",
      models: { orchestrator: "acp:claude-code/claude-opus-5-5" },
      folders: [{ path: "/Users/maya/code/release", label: "release" }],
    },
    now - 3 * HOUR,
  );
  startScript(release, now - 2 * HOUR, acpOrchestratorHistory);

  // An ACP orchestrator that could not start (GitHub Copilot is not logged in): nothing was stored, the turn failed.
  // The UI must show the failure and the login hint, and the project "Needs you" (owner's live test).
  const copilot = makeProject(
    {
      name: "Changelog bot",
      description: "Drafts weekly changelog entries",
      models: { orchestrator: "acp:copilot" },
      folders: [{ path: "/Users/maya/code/changelog", label: "changelog" }],
    },
    now - 50 * 60_000,
  );
  Object.assign(orchestratorOf(copilot), {
    status: "failed",
    error: "GitHub Copilot is not logged in.",
    error_hint: "Log in once with `copilot login`, then check again.",
    finished_at: new Date(now - 40 * 60_000).toISOString(),
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
  // Decision 98: a Maven module whose package directories each hold one directory (the owner's screenshot), for compact folders.
  const configurator = makeProject(
    {
      name: "Product configurator",
      description: "Java service: product data management subsystem",
      folders: [{ path: "/Users/maya/code/product-configurator", label: "product-configurator" }],
    },
    now - 45 * 24 * HOUR,
  );
  // A project of two folders whose names share a long head (the owner's real pair), and a project of one of them: the names
  // that end-truncation cannot tell apart.
  const pcms = makeProject(
    {
      name: "PCMS + PCFS",
      description: "Product configuration: management system and facade service",
      folders: [{ path: "/Users/maya/code/product-configuration-management-system" }, { path: "/Users/maya/code/product-configuration-facade-service" }],
    },
    now - 50 * 24 * HOUR,
  );
  const pcfs = makeProject({ name: "PCFS", folders: [{ path: "/Users/maya/code/product-configuration-facade-service" }] }, now - 51 * 24 * HOUR);
  payments.project.budget_usd = 120;
  payments.project.spent_usd = 38.2;
  return [orbit, atlas, docs, payments, infra, webhooks, release, copilot, tokens, stress, configurator, pcms, pcfs];
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

const SIDE_ANSWER = "The orchestrator is between steps: it is waiting on its agents. Nothing you ask here is added to its conversation.";

/** `?nokey=1` on the page: the hosts pass only seed / lsp / plugins, so the demo reads this knob itself. */
function nokeyFromUrl(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("nokey") === "1";
}

export function createDemoBridge(options: DemoOptions = {}): Bridge {
  const lspMode = options.lsp ?? "ok";
  const nokey = options.nokey ?? nokeyFromUrl();
  const pluginsOn = options.plugins ?? true;
  const failedOnce = new Set<string>();
  const records = new Map<string, ProjectRecord>();
  for (const rec of SEEDERS[options.seed ?? "full"]()) records.set(rec.project.id, rec);
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tour") === "1") seedTourState(records);

  const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
  const sides: { project: string; message: SideMessage }[] = [];
  // One earlier side question on Atlas API, so the pane opens with history (decision 40).
  const atlasId = [...records.values()].find((r) => r.project.name.startsWith("Atlas"))?.project.id;
  if (atlasId) {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    sides.push(
      { project: atlasId, message: { id: 1, side_id: "side_seed", role: "user", text: "Why did it pick the debugger for this?", created_at: at } },
      {
        project: atlasId,
        message: {
          id: 2,
          side_id: "side_seed",
          role: "assistant",
          text: "The bug only shows under concurrency, so it asked for a **reproduction first**: the debugger writes a failing test before anyone changes code (your project instructions require that).",
          created_at: at,
        },
      },
    );
  }
  // One compacted history, so the marker's state exists in the demo: Atlas API's orchestrator (the longest seeded
  // transcript; histories are played in, so the marker is computed when read) had its first exchange summarised.
  const compacted = [...records.values()].find((r) => r.project.name.startsWith("Atlas"))?.project.orchestrator_agent_id;
  const compactions = (rec: ProjectRecord, agentId: string): CompactionMarker[] => {
    const upto = agentId === compacted ? rec.messages.filter((m) => m.agent_id === agentId)[1] : undefined;
    return upto ? [{ upto_message_id: upto.id, at: upto.created_at, summary_tokens: 1_850 }] : [];
  };
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

  const { unusable, features, ...providerMethods } = demoProviders();
  /** A project as read: the stored models that cannot run now are listed, never refused (as the harness does). */
  const withIssues = (p: Project): Project => ({ ...clone(p), models_unavailable: unusable(p.models) });
  const remote = createDemoRemote();
  const bridge: Bridge = {
    remoteAccess: () => Promise.resolve(remote),
    // Providers, settings and diagnostics (decisions 53, 59): `?providers=none` shows the connect screen.
    ...providerMethods,
    health: async () => (await delay(), { ok: true, version: "demo" }),
    getConfig: async () => {
      await delay();
      const claude = {
        value: "acp:claude-code" as const,
        id: "claude-code",
        label: "Claude Code",
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
        default_model: "claude-sonnet-5-5",
      };
      const copilot = { value: "acp:copilot" as const, id: "copilot", label: "GitHub Copilot", models: [] };
      const codex = { value: "acp:codex" as const, id: "codex", label: "Codex", models: [] };
      return {
        pick_folder: true,
        // `?claude=loggedout`: the owner's setup, Claude Code the default agent and not logged in.
        default_models: claudeLoggedOut()
          ? { ...DEFAULT_MODELS, orchestrator: "acp:claude-code", fast: "acp:claude-code", balanced: "acp:claude-code", deep: "acp:claude-code" }
          : { ...DEFAULT_MODELS },
        default_max_depth: 3,
        // An Octo router in front of the harness (decision 37), unless the no-key variant is asked for.
        router: !nokey,
        ...(nokey ? {} : { router_capabilities: ["autoroute", "route_hints", "result_headers", "budget_key"] }),
        acp_orchestrators: pluginsOn ? [claude, copilot, codex] : [],
        builtin_loop: nokey
          ? { available: false, reason: "No API key: set ANTHROPIC_API_KEY for Octo's local service, or run it behind an Octo router." }
          : { available: true },
        default_orchestrator: nokey && pluginsOn ? "acp:claude-code" : DEFAULT_MODELS.orchestrator,
        features: features(),
      };
    },
    listProjects: async () => {
      await delay();
      return [...records.values()].map((r) => summary(r.project)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    },
    createProject: async (input) => {
      await delay();
      if (!input.name.trim()) throw new BridgeError(400, "invalid", "name is required");
      const rec = makeProject(input, Date.now());
      records.set(rec.project.id, rec);
      return withIssues(rec.project);
    },
    getProject: async (id) => (await delay(), withIssues(get(id).project)),
    updateProject: async (id, patch) => {
      await delay();
      const rec = get(id);
      const p = rec.project;
      if (patch.name !== undefined) p.name = patch.name;
      if (patch.description !== undefined) p.description = patch.description;
      if (patch.instructions !== undefined) p.instructions = patch.instructions;
      if (patch.max_depth !== undefined) p.max_depth = patch.max_depth;
      if (patch.access !== undefined) p.access = patch.access;
      if (patch.memory !== undefined) p.memory = { context: "full", recent_exchanges: 5, auto_memory: "off", ...p.memory, ...patch.memory };
      if (patch.models) p.models = { ...p.models, ...patch.models };
      if (patch.budget_usd !== undefined) {
        if (patch.budget_usd === null) delete p.budget_usd;
        else p.budget_usd = patch.budget_usd;
        p.spent_usd ??= 0;
      }
      if (patch.models?.orchestrator) {
        const orch = orchestratorOf(rec);
        orch.model = patch.models.orchestrator;
        emit(rec, { type: "agent.updated", agent: clone(orch) });
      }
      if (patch.folders) p.folders = dedupeFolders(patch.folders);
      p.folder_count = p.folders.length;
      p.updated_at = new Date().toISOString();
      emit(rec, { type: "project.updated", project: withIssues(p) });
      return withIssues(p);
    },
    deleteProject: async (id, opts) => {
      await delay();
      const rec = get(id);
      if (rec.turn && !opts?.force) throw new BridgeError(409, "turn_in_progress", "stop the running turn before deleting");
      if (rec.turn) rec.turn.cancelled = true;
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
    // An estimate from the stored text (≈ 4 characters a token) in the harness's six parts, summing to `used_tokens`.
    getContext: async (id, agentId) => {
      await delay();
      const rec = get(id);
      const agent = agentId ?? rec.project.orchestrator_agent_id;
      const msgs = rec.messages.filter((m) => m.agent_id === agent);
      const text = Math.round(msgs.reduce((n, m) => n + JSON.stringify(m.content).length, 0) / 4);
      const summary = compactions(rec, agent).reduce((n, c) => n + (c.summary_tokens ?? 0), 0);
      const parts = [
        { key: "system" as const, tokens: 2_400 },
        { key: "tools" as const, tokens: 3_100 },
        { key: "notes" as const, tokens: Math.min(2_000, rec.notes.length * 30) },
        { key: "messages" as const, tokens: Math.round(text * 0.45) },
        { key: "tool_results" as const, tokens: Math.round(text * 0.55) },
        { key: "summary" as const, tokens: summary },
      ];
      const used = parts.reduce((n, p) => n + p.tokens, 0);
      return { agent_id: agent, model: rec.project.models.orchestrator, window_tokens: 1_000_000, used_tokens: used, estimated: true, parts };
    },
    // Decision 65: the context button's popover. A harness project: seven categories at 41% of 200k, compacted two turns ago;
    // an agent project: only what the agent reports.
    getContextOverview: async (id) => {
      await delay();
      const rec = get(id);
      if (rec.project.models.orchestrator.startsWith("acp:"))
        return {
          window: 200_000,
          used: 61_000,
          source: "agent" as const,
          estimated: false,
          categories: [],
          last_request: { input: 58_000, cached: 49_000, output: 2_800 },
        };
      return {
        window: 200_000,
        used: 82_000,
        reserved: 8_000,
        source: "harness" as const,
        compacted_turns_ago: 2,
        categories: [
          { id: "messages", label: "Conversation", tokens: 21_400 },
          { id: "tool_results", label: "Tool results", tokens: 29_800 },
          {
            id: "tools",
            label: "Tool definitions",
            tokens: 9_300,
            // Decision 88: what is inside; the rows add up to the category.
            items: [
              ["read_file", 1_900, "Harness tools"],
              ["write_file", 1_700, "Harness tools"],
              ["run_command", 1_500, "Harness tools"],
              ["spawn_agent", 1_400, "Harness tools"],
              ["search_files", 900, "Harness tools"],
              ["list_dir", 700, "Harness tools"],
              ["web_fetch", 700, "Harness tools"],
              ["task_update", 500, "Harness tools"],
            ].map(([label, tokens, group]) => ({
              id: `tool:${String(label)}`,
              label: String(label),
              tokens: Number(tokens),
              group: String(group),
              loaded: true,
              estimated: true,
            })),
          },
          { id: "system", label: "Instructions and briefing", tokens: 7_200 },
          {
            id: "notes",
            label: "Project notes and memory",
            tokens: 6_100,
            items: [
              { id: "mem:index", label: "Memory index", tokens: 3_900, group: "Memory", loaded: true, estimated: true },
              { id: "mem:notes", label: "Pinned notes", tokens: 2_200, group: "Memory", loaded: true, estimated: true },
            ],
          },
          { id: "summary", label: "Compacted summary", tokens: 5_400 },
          {
            id: "files",
            label: "Project instruction files",
            tokens: 2_800,
            items: [{ id: "file:agents", label: "AGENTS.md", tokens: 2_800, path: "app:AGENTS.md", actions: ["open"], loaded: true, estimated: true }],
          },
        ],
        last_request: { input: 64_000, cached: 49_600, output: 3_100 },
        not_loaded: [
          {
            id: "mf:release",
            label: "release-checklist.md",
            tokens: 1_800,
            group: "Memory files",
            path: "/memories/release-checklist.md",
            actions: ["open"],
            loaded: false,
            estimated: true,
          },
          {
            id: "mf:ports",
            label: "dev-ports.md",
            tokens: 420,
            group: "Memory files",
            path: "/memories/dev-ports.md",
            actions: ["open"],
            loaded: false,
            estimated: true,
          },
        ],
        buffer_tokens: 12_000,
        largest_messages: [
          { message_id: 3, role: "user" as const, tokens: 4_100, preview: "Please read the migration guide and plan the upgrade of every package" },
          { message_id: 12, role: "assistant" as const, tokens: 3_600, preview: "Here is the plan: first the lockfile, then the build scripts" },
        ],
      };
    },
    compactNow: async (id) => {
      await delay();
      get(id);
      return { upto_message_id: 0, at: new Date().toISOString(), summary_tokens: 0, message_count: 0, manual: true as const };
    },
    // Side questions (decision 40): stored apart from the orchestrator's messages; the answer streams as side.delta
    // events and ends with side.done, like the harness.
    askSide: async (id, text) => {
      await delay();
      const rec = get(id);
      const sideId = newId("side");
      const message = { id: (sides.at(-1)?.message.id ?? 0) + 1, side_id: sideId, role: "user" as const, text, created_at: new Date().toISOString() };
      sides.push({ project: id, message });
      const answer = SIDE_ANSWER.split(/(?<= )/);
      answer.forEach((chunk, i) =>
        setTimeout(
          () => {
            if (!sides.some((x) => x.message.side_id === sideId)) return;
            emit(rec, { type: "side.delta", side_id: sideId, text: chunk });
            if (i < answer.length - 1) return;
            const done = { id: message.id + 1, side_id: sideId, role: "assistant" as const, text: SIDE_ANSWER, created_at: new Date().toISOString() };
            sides.push({ project: id, message: done });
            emit(rec, { type: "side.done", side_id: sideId, message: clone(done) });
          },
          300 + i * 40,
        ),
      );
      return { side_id: sideId, message: clone(message) };
    },
    listSide: async (id) => (await delay(), clone(sides.filter((x) => x.project === id).map((x) => x.message))),
    clearSide: async (id) => {
      await delay();
      for (let i = sides.length - 1; i >= 0; i--) if (sides[i]?.project === id) sides.splice(i, 1);
    },
    getTranscript: async (id, agentId) => (
      await delay(),
      { messages: clone(get(id).messages.filter((m) => m.agent_id === agentId)), compactions: compactions(get(id), agentId) }
    ),
    sendMessage: async (id, text) => {
      await delay();
      const rec = get(id);
      if (rec.turn) throw new BridgeError(409, "turn_in_progress", "a turn is already running");
      trace("sendMessage", text);
      startScript(rec, Date.now(), scriptFor(text));
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
    // Parallel sessions: the base bridge runs a session's turn on its root agent (the sessions layer, `sessions.ts`, owns the
    // session list, the queues and the running cap, and sends the default session's messages through the project route).
    sendSessionMessage: async (id, sid, text) => {
      await delay();
      const rec = get(id);
      const root = rec.agents.find((a) => a.parent_id === null && a.session_id === sid);
      if (!root) throw new BridgeError(404, "not_found", "session not found");
      if (rec.turns?.has(root.id)) throw new BridgeError(409, "turn_in_progress", "a turn is already running");
      trace("sendSessionMessage", text);
      startScript(rec, Date.now(), scriptFor(text), root.id);
      const sent = [...rec.messages].reverse().find((m) => m.agent_id === root.id && m.role === "user");
      if (!sent) throw new BridgeError(500, "internal", "message not recorded");
      return { message: clone(sent) };
    },
    stopSession: async (id, sid) => {
      await delay();
      throw new BridgeError(404, "not_found", `no session ${sid} in ${id}`);
    },
    createSession: async (id) => {
      await delay();
      throw new BridgeError(404, "not_found", `no sessions in ${id}`);
    },
    setDefaultSession: async (id, sid) => {
      await delay();
      throw new BridgeError(404, "not_found", `no session ${sid} in ${id}`);
    },
    listAllSessions: async () => (await delay(), []),
    listNotes: async (id) => (await delay(), clone(get(id).notes.map(listed))),
    getNote: async (id, noteId) => {
      await delay();
      const note = get(id).notes.find((n) => n.id === noteId);
      if (!note) throw new BridgeError(404, "not_found", "note not found");
      return clone(docOf(note));
    },
    createNote: async (id, input) => {
      await delay();
      const rec = get(id);
      const note = createDemoNote(rec.notes, input, Date.now());
      rec.notes.push(note);
      emit(rec, { type: "note.changed", note: clone(listed(note)), note_id: note.id });
      return clone(docOf(note));
    },
    updateNote: async (id, noteId, patch) => {
      await delay();
      const rec = get(id);
      const note = rec.notes.find((n) => n.id === noteId);
      if (!note) throw new BridgeError(404, "not_found", "note not found");
      patchDemoNote(rec.notes, note, patch);
      emit(rec, { type: "note.changed", note: clone(listed(note)), note_id: note.id });
      return clone(docOf(note));
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
    searchProjectFiles: async (id, params) => {
      await delay();
      await ensureSeeded(get(id));
      return searchDemoFiles(get(id), params);
    },
    createDirectory: async (id, input) => {
      await delay();
      await ensureSeeded(get(id));
      return mkdirDemo(get(id), input);
    },
    renameFile: async (id, input) => {
      await delay();
      await ensureSeeded(get(id));
      return renameDemo(get(id), input);
    },
    deleteFile: async (id, folder, path) => {
      await delay();
      await ensureSeeded(get(id));
      deleteDemo(get(id), folder, path);
    },
    complete: async (id, input, opts) => {
      const rec = get(id);
      const comp = rec.project.models.completion;
      if (!comp || comp === "off") return null;
      await delay();
      if (opts?.signal?.aborted) return null;
      const small = providerMethods.listProviders
        ? (await providerMethods.listProviders()).providers.find((p) => p.kind === "ollama")?.default_model
        : undefined;
      const model = comp === "small" ? (small ?? "qwen2.5-coder:1.5b") : comp.startsWith("ollama:") ? comp.slice("ollama:".length) : comp;
      const tail = input.prefix.split("\n").at(-1)?.trimEnd() ?? "";
      const text = tail.endsWith("{") ? "\n  return true;\n}" : tail ? " /* completed */" : "";
      if (!text) return null;
      return { text, model, ms: 42 };
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
      // Without a key nothing has answered yet: no rate-limit headers were seen (the Limits empty state).
      if (nokey) return [];
      const { demoLimits } = await import("./usage");
      return demoLimits(Date.now());
    },
    // Folder picker (decision 49): a fake home directory; the recent folders are the projects' own, newest first.
    listDirs: async (path) => {
      await delay();
      const { demoListDirs } = await import("./dirs");
      return demoListDirs(path);
    },
    // The system folder dialog (harness side): a fake path after a beat; `?pick=cancel` and `?pick=fail` are the other answers.
    pickFolder: async () => {
      await new Promise((r) => setTimeout(r, 400));
      const how = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("pick");
      if (how === "cancel") return { cancelled: true };
      if (how === "fail") return { error: "unavailable", message: "No folder dialog is available on this machine (no display)." };
      return { path: "/Users/maya/code/picked-from-dialog" };
    },
    recentFolders: async () => {
      await delay();
      const { demoRecentFolders } = await import("./dirs");
      const recs = [...records.values()].sort((a, b) => Date.parse(b.project.updated_at) - Date.parse(a.project.updated_at));
      return demoRecentFolders(recs.flatMap((r) => r.project.folders.map((f) => f.path)));
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
        throw new BridgeError(500, "spawn_failed", `${info.label} stopped while starting.`, {
          hint: "Try again. If it keeps happening, check that it runs in a terminal.",
          action: "retry",
          details: "exited during startup (exit status 1)",
        });
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
  const wrapped = withDemoBranches(
    withDemoSide(
      withDemoSlash(
        withDemoTerminals(
          withDemoCommands(withDemoReview(withDemoSessions(withDemoParity(withDemoV7(bridge, records), records), records), records), records),
          records,
        ),
        records,
      ),
      records,
      sideModeFromUrl(),
    ),
    records,
  );
  // The optional byte read (`fileBytesReader` in @octo/agent-client): image previews in Files.
  const readFileBytes: FileBytesReader["readFileBytes"] = async (id, folder, path) => {
    await delay();
    await ensureSeeded(get(id));
    return readDemoFileBytes(get(id), folder, path);
  };
  const withBytes: Bridge & FileBytesReader = { ...wrapped, readFileBytes };
  return withBytes;
}
