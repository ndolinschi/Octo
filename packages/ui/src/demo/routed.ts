import { act, say, sleep, turn, type Ctx } from "./runtime";
import { clone, emit, orchestratorOf, type ProjectRecord } from "./store";

/**
 * Demo states for the router and ACP work (decision 37, ACP in the UI): what a router reported (served models that
 * differ from the requested ones, a budget, a routing policy) and an orchestrator that runs as an ACP agent.
 */

/** Two ids that differ only at the end: Usage must keep them apart (middle truncation keeps the tail). */
export const SERVED = ["deepseek/deepseek-v4.1-flash-0905", "deepseek/deepseek-v4.1-flash-1120"] as const;

/** After a history has played: the router answered with other models than the ones asked for. */
export function routeAgents(rec: ProjectRecord, orchestrator: string): void {
  let i = 0;
  for (const a of rec.agents) {
    if (a.model.startsWith("acp:")) continue;
    const served = a.parent_id === null ? orchestrator : (SERVED[i++ % SERVED.length] ?? orchestrator);
    Object.assign(a, { served_model: served, routed_tier: a.parent_id === null ? "fast" : "balanced" });
    // Delegations spawned with tier `auto`: the router's decision, in its words.
    if (a.parent_id !== null && i % 2 === 1)
      Object.assign(a, { route_choice: "balanced", route_band: "medium", route_reason: "The balanced tier was enough for a change of this size" });
    emit(rec, { type: "agent.updated", agent: clone(a) });
  }
}

/** What the harness carries when an ACP agent refused its MCP server: a completed turn with a `warning:` error. */
export const ACP_WARNING = "warning: Claude Code ran this request without Octo's own tools (agents, notes, plans).";

/** An orchestrator that runs as Claude Code over ACP: one finished request, with the warning above on its agent. */
export async function acpOrchestratorHistory(ctx: Ctx): Promise<void> {
  await turn(ctx, "Draft the release notes for 4.2 from the merged changes since 4.1.", async (c, orch) => {
    await act(c, orch, [
      { name: "read", input: { title: "Read CHANGELOG.md", locations: [{ path: "/Users/maya/code/release/CHANGELOG.md" }] }, result: "212 lines", ms: 500 },
    ]);
    await say(
      c,
      orch,
      "Drafted the 4.2 notes: **9 changes** in three groups.\n\n| Area | Changes | Breaking |\n| --- | ---: | --- |\n| API | 4 | no |\n| Web | 3 | no |\n| CLI | 2 | yes |\n\nThe CLI's `--format` flag changed its default; I flagged it at the top.",
    );
  });
  const orch = orchestratorOf(ctx.rec);
  Object.assign(orch, { error: ACP_WARNING });
  emit(ctx.rec, { type: "agent.updated", agent: clone(orch) });
  await sleep(ctx, 0);
}

/** A request whose tools return tables (decision 44): a CSV report and a JSON list of flat records. */
export async function tablesTurn(ctx: Ctx): Promise<void> {
  await turn(ctx, "Which docs pages are the slowest to build, and which links are still broken?", async (c, orch) => {
    await act(c, orch, [
      {
        name: "bash",
        input: { command: "pnpm astro build --timings --format csv" },
        result: [
          "page,ms,images,size_kb",
          "guide/deploy,1840,14,312",
          "api/reference,1422,0,1104",
          "migration/v1-to-v2,960,6,188",
          "getting-started,610,9,142",
          "changelog,540,0,96",
        ].join("\n"),
        ms: 900,
      },
      {
        name: "read_file",
        input: { path: "reports/links.json" },
        result: JSON.stringify(
          [
            { page: "guide/auth", link: "/guide/tokens", status: 404 },
            { page: "api/errors", link: "/api/v1/errors", status: 410 },
            { page: "changelog", link: "https://status.example.com", status: 503 },
          ],
          null,
          2,
        ),
        ms: 300,
      },
    ]);
    await say(
      c,
      orch,
      "The deploy guide is the slowest page: its 14 images are re-encoded on every build.\n\n| Page | Build ms | Images | Size KB |\n| --- | ---: | ---: | ---: |\n| guide/deploy | 1,840 | 14 | 312 |\n| api/reference | 1,422 | 0 | 1,104 |\n| migration/v1-to-v2 | 960 | 6 | 188 |\n\nThree links are still broken (two moved pages and the status site, which was down during the crawl).",
    );
  });
}
