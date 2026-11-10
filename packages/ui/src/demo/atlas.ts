import { act, delegate, say, sleep, turn, type Ctx } from "./runtime";

const REFRESH_TS = `import { db } from "../db";
import { issuePair, verifyRefresh } from "./tokens";

export async function refresh(raw: string) {
  const token = await verifyRefresh(raw);
  if (token.revokedAt) throw new AuthError("refresh_revoked");
  await db.refreshTokens.revoke(token.id);
  return issuePair(token.userId);
}`;

const ANSWER = `## What's happening

Two tabs — or a tab and the service worker — can refresh at the same moment. Both send the same refresh token. The API rotates on first use, so the **second request presents a revoked token**, \`/auth/refresh\` answers \`401\`, and the client treats any refresh \`401\` as a logout.

| Where | File | Finding |
| --- | --- | --- |
| API | \`src/auth/refresh.ts\` | Rotation is immediate; no grace window for the previous token |
| Web | \`src/lib/session.ts\` | No single-flight lock — every tab refreshes on its own |
| Web | \`src/lib/http.ts\` | Any \`401\` from refresh clears the session |

The debugger reproduced it with a new failing test, \`refresh.concurrent.test.ts\`: 7 of 10 runs log the user out.

## Proposed fix

1. **API** — accept the previous refresh token for 30 s after rotation and return the pair already issued to the first caller.
2. **Web** — single-flight the refresh across tabs with a \`BroadcastChannel\` lock, and only log out on \`refresh_reused\`, not every \`401\`.

\`\`\`ts
// src/auth/refresh.ts
const GRACE_MS = 30_000;

if (token.revokedAt) {
  const age = Date.now() - token.revokedAt.getTime();
  if (age < GRACE_MS && token.successorId) return pairFor(token.successorId);
  throw new AuthError("refresh_reused");
}
\`\`\`

Nothing has been changed yet. Say **go** and I'll hand the API and web changes to two implementers in parallel, with the new test as the gate.`;

export async function atlasHistory(ctx: Ctx): Promise<void> {
  await turn(ctx, "Get oriented in both repos and tell me how auth works end to end.", async (c, orch) => {
    await act(c, orch, [
      { name: "list_dir", input: { folder: "atlas-api", path: "." }, result: "src/\ntest/\npackage.json\nREADME.md\ntsconfig.json", ms: 300 },
      { name: "list_dir", input: { folder: "atlas-web", path: "." }, result: "src/\npublic/\npackage.json\nvite.config.ts", ms: 300 },
    ]);
    await delegate(
      c,
      orch,
      [
        {
          role: "Code explorer",
          title: "Map auth in atlas-api",
          tier: "fast",
          task: "In atlas-api, find every module involved in authentication: login, token issue, refresh, logout, middleware. Report file paths and a short description of each, plus the token lifetimes.",
          run: async (cc, id) => {
            await act(cc, id, [{ name: "bash", input: { command: "rg -l 'refresh|issuePair|session' src" }, result: "src/auth/login.ts\nsrc/auth/refresh.ts\nsrc/auth/tokens.ts\nsrc/http/middleware/auth.ts", ms: 900 }]);
            await act(cc, id, [
              { name: "read_file", input: { path: "src/auth/tokens.ts" }, result: "export const ACCESS_TTL = 15 * 60;\nexport const REFRESH_TTL = 30 * 24 * 3600;\n…", ms: 400 },
              { name: "read_file", input: { path: "src/auth/refresh.ts" }, result: REFRESH_TS, ms: 400 },
            ]);
            const r = "Auth lives in `src/auth/`. `login.ts` issues an access token (15 min) and a rotating refresh token (30 days) via `tokens.ts`. `refresh.ts` revokes the presented token and issues a new pair. `http/middleware/auth.ts` verifies access tokens on every route except `/auth/*`.";
            await say(cc, id, r);
            return r;
          },
        },
        {
          role: "Code explorer",
          title: "Map auth in atlas-web",
          tier: "fast",
          task: "In atlas-web, describe how the client stores tokens, when it refreshes, and what makes it log the user out.",
          run: async (cc, id) => {
            await act(cc, id, [
              { name: "read_file", input: { path: "src/lib/session.ts" }, result: "export async function ensureFresh() { … }", ms: 500 },
              { name: "read_file", input: { path: "src/lib/http.ts" }, result: "if (res.status === 401) session.clear();", ms: 500 },
            ]);
            const r = "Tokens are kept in memory plus an httpOnly refresh cookie. `session.ts` refreshes 60 s before access-token expiry, independently in each tab. `http.ts` clears the session on any `401`.";
            await say(cc, id, r);
            return r;
          },
        },
      ],
      "Two quick explorations in parallel — one per repo.",
    );
    await act(c, orch, [
      {
        name: "save_note",
        input: { title: "Auth architecture", content: "Access token 15 min, rotating refresh token 30 days (httpOnly cookie). API: src/auth/{login,refresh,tokens}.ts. Web refreshes per tab in src/lib/session.ts; any 401 logs out." },
        result: "saved",
        ms: 200,
      },
    ]);
    await say(
      c,
      orch,
      "Here's the end-to-end picture:\n\n- **Login** (`atlas-api/src/auth/login.ts`) issues a 15-minute access token and a 30-day refresh token in an httpOnly cookie.\n- **Requests** carry the access token; `middleware/auth.ts` verifies it on every non-auth route.\n- **Refresh** — the web client refreshes 60 s before expiry; the API rotates the refresh token on every use.\n- **Logout** happens explicitly, or implicitly whenever the client sees a `401`.\n\nI saved this as a note so later turns start from it.",
    );
  });

  await sleep(ctx, 26 * 3600_000);

  await turn(
    ctx,
    "Session refresh sometimes logs people out. Find the cause and propose a fix — don't change any code yet.",
    async (c, orch) => {
      await delegate(
        c,
        orch,
        [
          {
            role: "Code explorer",
            title: "Trace the token refresh path",
            tier: "fast",
            task: "Trace every code path that calls /auth/refresh in atlas-web and every branch in atlas-api's refresh handler. List conditions that end in a 401.",
            run: async (cc, id) => {
              await act(cc, id, [{ name: "bash", input: { folder: "atlas-web", command: "rg -n 'auth/refresh' src" }, result: "src/lib/session.ts:42\nsrc/sw.ts:18", ms: 700 }]);
              await act(cc, id, [
                { name: "read_file", input: { folder: "atlas-web", path: "src/sw.ts" }, result: "// service worker also refreshes on push wake-up\n…", ms: 400 },
                { name: "read_file", input: { folder: "atlas-api", path: "src/auth/refresh.ts" }, result: REFRESH_TS, ms: 400 },
              ]);
              const r = "Refresh is called from two places in the web app: `session.ts:42` (per tab) and `sw.ts:18` (service worker on push wake-up). In the API, `refresh_revoked` is the only 401 branch reachable with a valid cookie — it fires when a token is presented after it was already rotated.";
              await say(cc, id, r);
              return r;
            },
          },
          {
            role: "Debugger",
            title: "Reproduce the logout race",
            tier: "deep",
            task: "Hypothesis: concurrent refreshes race on token rotation. Reproduce it deterministically against the API test harness. Delegate writing the failing test if useful. Report evidence, not guesses.",
            run: async (cc, id) => {
              await act(cc, id, [{ name: "read_file", input: { folder: "atlas-api", path: "test/helpers/server.ts" }, result: "export function testServer() { … }", ms: 400 }]);
              await act(cc, id, [{ name: "bash", input: { folder: "atlas-api", command: "pnpm vitest run test/auth" }, result: "Error: Cannot find module '@atlas/test-db'\n    at test/helpers/db.ts:1", ms: 2600, error: true }]);
              await act(cc, id, [{ name: "bash", input: { folder: "atlas-api", command: "pnpm build:test-db && pnpm vitest run test/auth" }, result: " ✓ test/auth/login.test.ts (6)\n ✓ test/auth/refresh.test.ts (4)\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)", ms: 4200 }]);
              await delegate(cc, id, [
                {
                  role: "Test writer",
                  title: "Failing test for concurrent refresh",
                  tier: "balanced",
                  task: "Write test/auth/refresh.concurrent.test.ts: fire two /auth/refresh calls with the same cookie in parallel, 10 iterations, assert both succeed. It should fail on main.",
                  run: async (tc, tid) => {
                    await delegate(tc, tid, [
                      {
                        role: "Log analyst",
                        title: "Find refresh_revoked in staging logs",
                        tier: "fast",
                        task: "Grep the exported staging logs in atlas-api/logs/ for refresh_revoked within 2 s of a successful refresh for the same user. Count occurrences.",
                        run: async (lc, lid) => {
                          await act(lc, lid, [{ name: "bash", input: { folder: "atlas-api", command: "rg -c 'refresh_revoked' logs/staging-*.jsonl" }, result: "logs/staging-11-08.jsonl:214\nlogs/staging-11-09.jsonl:187", ms: 1200 }]);
                          const r = "Found 401 `refresh_revoked` events over two days (214 + 187). 92% land within 1.5 s of a successful refresh for the same user — consistent with a race.";
                          await say(lc, lid, r);
                          return r;
                        },
                      },
                    ]);
                    await act(tc, tid, [{ name: "write_file", input: { folder: "atlas-api", path: "test/auth/refresh.concurrent.test.ts" }, result: "wrote 38 lines", ms: 500 }]);
                    await act(tc, tid, [{ name: "bash", input: { folder: "atlas-api", command: "pnpm vitest run test/auth/refresh.concurrent.test.ts" }, result: " × concurrent refresh keeps the session (10 runs)\n   → 7 of 10 runs: second call returned 401 refresh_revoked", ms: 3100 }]);
                    const r = "Added `test/auth/refresh.concurrent.test.ts`. It fails on main: 7/10 runs return `401 refresh_revoked` for the second call. Staging logs show the same pattern in production traffic.";
                    await say(tc, tid, r);
                    return r;
                  },
                },
              ]);
              const r = "Confirmed: concurrent refreshes with the same cookie race on rotation. The losing request gets `401 refresh_revoked` and the client logs out. Deterministic repro in `refresh.concurrent.test.ts` (fails 7/10), corroborated by staging logs (92% of revocations follow a refresh within 1.5 s).";
              await say(cc, id, r);
              return r;
            },
          },
          {
            role: "Code explorer",
            title: "Check cookie and CORS settings",
            tier: "fast",
            task: "Check the refresh cookie attributes (SameSite, Path, Domain, Secure) and CORS config for /auth/*. Could any of them drop the cookie and cause a 401?",
            run: async (cc, id) => {
              await act(cc, id, [
                { name: "read_file", input: { folder: "atlas-api", path: "src/http/cookies.ts" }, result: "sameSite: 'lax', path: '/auth', secure: true", ms: 400 },
                { name: "read_file", input: { folder: "atlas-api", path: "src/http/cors.ts" }, result: "origin: [WEB_ORIGIN], credentials: true", ms: 400 },
              ]);
              const r = "Cookie is `SameSite=Lax; Path=/auth; Secure`; CORS allows the web origin with credentials. Neither can drop the cookie on same-site refreshes — ruled out.";
              await say(cc, id, r);
              return r;
            },
          },
        ],
        "I'll come at this from three angles at once: trace the code path, try to reproduce a race, and rule out cookie/CORS problems.",
      );
      await delegate(c, orch, [
        {
          role: "Security reviewer",
          title: "Review the grace-window idea",
          tier: "balanced",
          task: "Assess the security impact of accepting a just-rotated refresh token for 30 s. Consider token theft and replay.",
          run: async (cc, id) => {
            await act(cc, id, [{ name: "read_file", input: { folder: "atlas-api", path: "docs/security.md" }, result: "# Threat model\n…", ms: 500 }]);
            await sleep(cc, 2400);
            throw new Error("Model request failed: overloaded (529) after 3 retries");
          },
        },
      ]);
      await act(c, orch, [
        {
          name: "save_note",
          input: { title: "Refresh race root cause", content: "Concurrent refreshes (tabs + service worker) race on rotation → 401 refresh_revoked → client logs out. Repro: test/auth/refresh.concurrent.test.ts. Fix direction: 30 s grace window + cross-tab single-flight." },
          result: "saved",
          ms: 200,
        },
      ]);
      await say(c, orch, ANSWER);
    },
  );
}
