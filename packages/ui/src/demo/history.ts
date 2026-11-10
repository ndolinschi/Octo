import { act, delegate, say, sleep, turn, type ChildSpec, type Ctx, type ToolSpec } from "./runtime";

/**
 * Months of past work for the overview surfaces (Home heat map, This month, Details activity and files):
 * turns spread over the last 26 weeks in bursts, each delegating to one to three sub-agents that read and
 * write files. Deterministic (seeded), so a reload shows the same history.
 */

const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export type HistorySpec = {
  seed: number;
  /** Turn prompts, cycled. */
  prompts: string[];
  /** Files the sub-agents write, folder-relative (the project's first folder). */
  files: string[];
  /** Roles the orchestrator delegates to. */
  roles: string[];
  /** How many turns, spread from `days` ago up to two days ago. */
  turns: number;
  days: number;
};

const ANSWERS = [
  "Done. The change is small and covered by the existing tests; nothing else moved.",
  "Finished: two files changed, one new test. The diff is in the agents' transcripts.",
  "All green. I left a note about the follow-up we discussed.",
  "Reviewed and applied. One open question is in the notes for you.",
];

/** Plays `spec.turns` past turns into the project, oldest first. Sleeps are in the past, so this is instant. */
export async function pastHistory(ctx: Ctx, spec: HistorySpec): Promise<void> {
  const rand = rng(spec.seed);
  const now = Date.now();
  // Bursty days: weight weeks unevenly so the heat map has texture (quiet weeks, busy weeks).
  const start = now - spec.days * DAY;
  const span = (spec.days - 2) * DAY;
  const times = Array.from({ length: spec.turns }, () => {
    const week = Math.floor(rand() ** 0.7 * (spec.days / 7));
    const day = week * 7 + Math.floor(rand() * 5);
    const hour = 9 + Math.floor(rand() * 9);
    return Math.min(start + span, start + day * DAY + hour * 3_600_000 + Math.floor(rand() * 3_600_000));
  }).sort((a, b) => a - b);

  for (const [i, at] of times.entries()) {
    if (at > ctx.t) ctx.t = at;
    const prompt = spec.prompts[i % spec.prompts.length] ?? "Continue.";
    const kids = 1 + Math.floor(rand() * 3);
    await turn(ctx, prompt, async (c, orch) => {
      const children: ChildSpec[] = Array.from({ length: kids }, (_, k) => {
        const file = spec.files[Math.floor(rand() * spec.files.length)] ?? "README.md";
        const writes = rand() < 0.7;
        const role = spec.roles[(i + k) % spec.roles.length] ?? "Implementer";
        return {
          role,
          title: prompt.split(" ").slice(0, 5).join(" "),
          tier: k === 0 ? "balanced" : "fast",
          task: `${prompt} Work on \`${file}\` and report what changed.`,
          run: async (cc, id) => {
            const tools: ToolSpec[] = [{ name: "read_file", input: { path: file }, result: `// ${file}\n…`, ms: 300 }];
            if (writes)
              tools.push({
                name: "write_file",
                input: { path: file, content: `// ${file}\n` },
                result: "written",
                ms: 300,
                content: `// ${file} — updated by ${role}\n`,
              });
            await act(cc, id, tools);
            const r = writes ? `Updated \`${file}\`.` : `Read \`${file}\`; no change needed.`;
            await say(cc, id, r);
            return r;
          },
        };
      });
      await delegate(c, orch, children);
      await say(c, orch, ANSWERS[i % ANSWERS.length] ?? "Done.");
    });
    await sleep(ctx, 60_000);
  }
}

/** A recent turn whose answer exercises the chat: code in five languages, file links with lines, a numeric table. */
export async function ledgerShowcase(ctx: Ctx): Promise<void> {
  await turn(ctx, "Why did the EU settlement total drift by €4.12 last Tuesday? Show me the fix before you apply it.", async (c, orch) => {
    await act(c, orch, [
      { name: "read_file", input: { path: "jobs/settle.ts" }, result: "export async function settle(batch: Batch) { … }", ms: 400 },
      {
        name: "bash",
        input: { command: "pnpm settle --region eu --date 2026-11-03 --dry-run --json" },
        result: '{ "merchants": 1284, "total": "2418899.05", "mismatches": 3 }',
        ms: 900,
      },
    ]);
    await say(
      c,
      orch,
      `The drift comes from rounding each line before summing. Three merchants with many sub-cent fees lost a cent per line — **€4.12** in total. The rounding is in \`ledger/jobs/settle.ts:12-20\`; the report query in \`ledger/reports/eu.sql\` is fine.

| Merchant | Lines | Expected | Settled | Drift |
| --- | --- | --- | --- | --- |
| m_8812 | 2,104 | 18,204.31 | 18,202.19 | −2.12 |
| m_1190 | 1,377 | 9,880.07 | 9,878.92 | −1.15 |
| m_4471 | 851 | 4,113.60 | 4,112.75 | −0.85 |

The fix sums in minor units and rounds once:

\`\`\`ts
// jobs/settle.ts
export function total(lines: Line[]): Money {
  const minor = lines.reduce((sum, l) => sum + l.amountMinor, 0n);
  return Money.fromMinor(minor, "EUR"); // one rounding, at the end
}
\`\`\`

\`\`\`diff
@@ -12,9 +12,6 @@ export async function settle(batch: Batch) {
-  let sum = 0;
-  for (const line of batch.lines) sum += Math.round(line.amount * 100) / 100;
-  return sum;
+  return total(batch.lines);
 }
\`\`\`

The dry run's output, for the record:

\`\`\`json
{ "merchants": 1284, "total": "2418899.05", "mismatches": 3, "region": "eu" }
\`\`\`

To check it yourself before I apply anything:

\`\`\`bash
pnpm settle --region eu --date 2026-11-03 --dry-run --json | jq '.mismatches'
\`\`\`

The Go reconciler (\`ledger/cmd/reconcile/main.go\`) already does this right:

\`\`\`go
func total(lines []Line) int64 {
	var sum int64
	for _, l := range lines {
		sum += l.AmountMinor
	}
	return sum
}
\`\`\`

Say **apply** and I'll make the change with a test that fails today.`,
    );
  });
}

/** An ACP agent run (decision F3): a plugin agent reads, edits and runs a command; its calls carry titles and locations. */
export async function infraAcpTurn(ctx: Ctx, root: string): Promise<void> {
  await turn(ctx, "Have the external agent write upgrade notes for the node pool module.", async (c, orch) => {
    await delegate(
      c,
      orch,
      [
        {
          role: "External agent",
          title: "Upgrade notes for node-pool",
          tier: "balanced",
          acp: "claude-code",
          task: "Read the module README and write docs/upgrade-notes.md for the node-pool v2 upgrade.",
          run: async (cc, id) => {
            await act(cc, id, [
              {
                name: "read",
                input: { title: "Read README.md", raw_input: { path: `${root}/README.md` }, locations: [{ path: `${root}/README.md` }] },
                result: "# Project\n\nAttach notes about setup here.\n",
                ms: 400,
              },
              {
                name: "search",
                input: { title: "Search for node_pool in modules", raw_input: { pattern: "node_pool", path: `${root}/modules` } },
                result: "modules/node-pool/main.tf:3",
                ms: 300,
              },
            ]);
            await act(cc, id, [
              {
                name: "edit",
                input: {
                  title: "Write docs/upgrade-notes.md",
                  raw_input: { path: `${root}/docs/upgrade-notes.md` },
                  locations: [{ path: `${root}/docs/upgrade-notes.md`, line: 1 }],
                },
                result: "Wrote 18 lines",
                ms: 500,
                content: "# Node pool v2 upgrade\n\n1. Plan staging first.\n2. Drain the old pools.\n",
              },
              { name: "execute", input: { title: "Run terraform fmt -check", raw_input: { command: "terraform fmt -check" } }, result: "exit 0", ms: 600 },
            ]);
            const r = "Wrote `infra/docs/upgrade-notes.md` (drain order, the autoscaler change, rollback). `terraform fmt -check` passes.";
            await say(cc, id, r);
            return r;
          },
        },
      ],
      "I'll hand this to the external agent from the web-tools plugin.",
    );
    await say(c, orch, "The external agent wrote `infra/docs/upgrade-notes.md`; read it before the staging plan. Nothing else changed.");
  });
}
