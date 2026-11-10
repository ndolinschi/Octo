import { act, say, sleep, turn, type Ctx } from "./runtime";

/** Docs site: a long history of small requests (exercises "Show all" in the sidebar). */
const DOCS_REQUESTS: [string, string][] = [
  ["Set up the docs project structure and tell me what's there.", "The site is Astro 4 with content collections under `src/content/docs/`. 38 pages, one sidebar config, no search yet."],
  ["Add a search box to the docs header.", "Added Pagefind: it indexes at build time and needs no server. The header now has a search field; the index is 412 KB."],
  ["Why is the build slow on CI?", "Image optimisation runs on every build because the cache directory isn't persisted. Caching `node_modules/.astro` cuts the build from 6m 10s to 1m 40s."],
  ["Fix the broken links report from last night's crawl.", "17 broken links: 12 point at the old `/guide/` prefix, 5 at removed API pages. I redirected the prefix and removed the dead references."],
  [
    [
      "Write a migration guide from v1 to v2 of the API. Structure it like this:",
      "",
      "1. Who needs to migrate, and by when (v1 is switched off on 31 March).",
      "2. Renamed endpoints, as a table: old path, new path, notes.",
      "3. Pagination: v1 used page/limit, v2 uses an opaque cursor.",
      "   Show a loop that walks every page in both styles.",
      "4. Auth: the X-Api-Key header is replaced by a Bearer token.",
      "   Explain how to create a token in the dashboard.",
      "5. Errors: v2 returns problem+json; list the codes that changed.",
      "6. Webhooks: the signature header moved and the payload is versioned.",
      "7. SDKs: which versions support v2, and the one-line upgrade command.",
      "8. A checklist at the end that a team can tick off.",
      "",
      "Constraints:",
      "- Every snippet must be copy-pasteable and tested against the sandbox.",
      "- Keep it on one page; link out to the reference for details.",
      "- Use the same tone as the getting-started guide.",
      "- Don't promise dates we haven't announced.",
      "",
      "Put it at migration/v1-to-v2.md and add it to the sidebar under Guides.",
    ].join("\n"),
    "Drafted `migration/v1-to-v2.md`: renamed endpoints, the new pagination cursor, and the auth header change, each with before/after snippets.",
  ],
  ["Make code blocks copyable.", "Code blocks now have a copy button (keyboard reachable, announces \"Copied\"). No new dependency."],
  ["Check the docs for accessibility problems.", "Found 9 issues: missing alt text on 6 diagrams, low-contrast callouts, and a skip link that targets nothing. All fixed except the diagrams, which need captions from you."],
  ["Add a changelog page generated from the releases.", "Added `/changelog`, generated at build time from the GitHub releases feed and cached for an hour in dev."],
  ["Proofread the getting-started guide.\nKeep the tone, fix only errors and unclear sentences.", "Fixed 14 typos and rewrote 3 sentences that described steps out of order. The tone is unchanged."],
];

export async function docsHistory(ctx: Ctx): Promise<void> {
  for (const [i, [prompt, answer]] of DOCS_REQUESTS.entries()) {
    await turn(ctx, prompt, async (c, orch) => {
      if (i % 3 === 1) await act(c, orch, [{ name: "list_dir", input: { path: "src/content/docs" }, result: "getting-started.md\nguide/\napi/\nmigration/", ms: 400 }]);
      await say(c, orch, answer);
    });
    await sleep(ctx, 47 * 60_000);
  }
}

/**
 * A short turn that started just before the app loaded and finishes a few seconds after,
 * so the project shows unseen activity in the sidebar until it is opened.
 */
export function backgroundTurn(prompt: string, tool: { name: string; input: Record<string, unknown>; result: string }, answer: string, ms: number) {
  return async (ctx: Ctx): Promise<void> => {
    await turn(ctx, prompt, async (c, orch) => {
      await act(c, orch, [{ ...tool, ms }]);
      await say(c, orch, answer);
    });
  };
}
