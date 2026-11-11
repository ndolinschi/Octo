/**
 * Scripted memory of a long-running project for the demo (`?demo=1`): 30 task records, 80 facts (some superseded, one
 * across tasks), 12 memory files. Plain data; `memory.ts` dates it and links it to the project's real messages.
 */

export type TaskSpec = {
  title: string;
  status: "open" | "done" | "dropped";
  goal: string;
  goalBy?: "harness" | "orchestrator" | "digest";
  constraints?: string[];
  acceptance?: string[];
  decisions?: string[];
  outcome?: string;
  files?: string[];
  /** Facts, oldest first. A fact that starts with "~" is superseded by the next one in the list. */
  facts: string[];
  /** Days since the task was opened. */
  age: number;
};

export const TASKS: TaskSpec[] = [
  {
    title: "Refresh tokens rotate on every use",
    status: "open",
    goal: "Rotate the refresh token on every use and revoke the whole family when an old one is replayed.",
    goalBy: "orchestrator",
    constraints: ["Keep the 30-day lifetime", "No change to the access-token format", "Postgres only, no Redis"],
    acceptance: ["Replaying a used refresh token revokes the family", "test/auth/refresh.test.ts passes", "p95 of /auth/refresh stays under 40 ms"],
    decisions: ["Families are stored as a parent id column, not a separate table", "Replay detection logs at warn, not error"],
    files: ["src/auth/refresh.ts", "src/auth/tokens.ts", "src/db/index.ts", "test/auth/refresh.test.ts"],
    facts: [
      "~Refresh tokens live for 14 days",
      "Refresh tokens live for 30 days",
      "Access tokens live for 15 minutes",
      "The owner wants replay detection to revoke the whole family",
      "Rotation is atomic: one UPDATE … RETURNING",
    ],
    age: 2,
  },
  {
    title: "Login rate limit per account and per IP",
    status: "open",
    goal: "Limit failed logins to 5 per account per 15 minutes and 50 per IP per hour, with a clear 429 body.",
    goalBy: "digest",
    constraints: ["Counters in Postgres", "Do not lock accounts permanently"],
    acceptance: ["The sixth failed login inside 15 minutes gets 429", "The body names when to retry"],
    decisions: ["Sliding window, not fixed buckets"],
    files: ["src/auth/login.ts", "src/http/middleware/rateLimit.ts"],
    facts: ["~The per-IP limit is 100 per hour", "The per-IP limit is 50 per hour", "Retry-After is sent in seconds"],
    age: 4,
  },
  {
    title: "Billing webhooks are idempotent",
    status: "open",
    goal: "Process each Stripe event exactly once even when Stripe retries or two workers receive it.",
    goalBy: "orchestrator",
    constraints: ["Use the event id as the key", "Keep events for 90 days"],
    acceptance: ["A duplicate delivery is acknowledged without a second side effect", "A crash between write and ack is replayed safely"],
    decisions: ["A unique index on stripe_events(id) is the lock"],
    files: ["src/billing/webhooks.ts", "migrations/0031_stripe_events.sql"],
    facts: ["Stripe retries for up to 3 days", "Webhook secret is read from STRIPE_WEBHOOK_SECRET", "Events older than 90 days are deleted nightly"],
    age: 6,
  },
  {
    title: "Dashboard: invoices table paginates on the server",
    status: "open",
    goal: "Move invoice pagination to the API with cursor paging; the dashboard asks for 50 rows at a time.",
    goalBy: "digest",
    acceptance: ["An account with 20 000 invoices opens in under a second"],
    files: ["src/billing/invoices.ts", "web/src/pages/Invoices.tsx"],
    facts: ["Cursor is the invoice's created_at plus id", "~Page size is 100", "Page size is 50"],
    age: 7,
  },
  {
    title: "CI: Rust toolchain for the migrate tool",
    status: "done",
    goal: "Pin the toolchain CI uses for tools/migrate and cache its target directory.",
    decisions: ["rust-toolchain.toml in tools/migrate, not a CI matrix"],
    outcome: "CI pins Rust 1.88 and caches target/; the migrate job went from 6 min to 1 min 40 s.",
    files: [".github/workflows/ci.yml", "tools/migrate/rust-toolchain.toml"],
    facts: ["~CI runs on Rust 1.86", "CI runs on Rust 1.88", "The migrate job takes about 1 min 40 s with the cache"],
    age: 9,
  },
  {
    title: "Session cookies: SameSite and path",
    status: "done",
    goal: "Scope the refresh cookie to /auth with SameSite=Lax and Secure everywhere but localhost.",
    outcome: "Cookie options are in src/http/cookies.ts; Secure is off only when WEB_ORIGIN is http://localhost.",
    files: ["src/http/cookies.ts"],
    facts: ["The refresh cookie's path is /auth", "SameSite is Lax"],
    age: 11,
  },
  {
    title: "Postgres connection pool sizing",
    status: "done",
    goal: "Find why requests queue under load and size the pool for the API and the workers.",
    decisions: ["API pool 20, workers 5, statement timeout 5 s"],
    outcome: "Queueing came from the default pool of 10 shared with the workers; split pools fixed p99.",
    files: ["src/db/index.ts"],
    facts: ["~The pool size is 10", "The API pool size is 20", "Workers use a pool of 5", "Statement timeout is 5 s"],
    age: 13,
  },
  {
    title: "Threat model: token theft",
    status: "done",
    goal: "Write down what happens when an access or refresh token leaks and what limits the damage.",
    outcome: "docs/security.md has the token-theft section; memory file security/threat-model.md summarises it.",
    files: ["docs/security.md"],
    facts: ["A stolen access token is usable for at most 15 minutes", "A replayed refresh token revokes its family"],
    age: 15,
  },
  {
    title: "Fastify 5 upgrade",
    status: "done",
    goal: "Upgrade from Fastify 4 to 5 and fix the plugin signatures that changed.",
    outcome: "Upgraded to fastify 5.2.1; two plugins needed the new async signature; all tests pass.",
    files: ["package.json", "src/index.ts", "src/http/cors.ts"],
    facts: ["Fastify is on 5.2.1", "@fastify/cors needed version 11"],
    age: 17,
  },
  {
    title: "Audit log for admin actions",
    status: "open",
    goal: "Record who changed what on accounts and plans, readable by support without database access.",
    goalBy: "harness",
    constraints: ["Never log tokens or card data"],
    facts: ["Support reads the audit log through the admin dashboard", "Audit rows are kept for one year"],
    age: 18,
  },
  {
    title: "Plan limits: seats and projects",
    status: "open",
    goal: "Enforce seat and project limits per plan on create, with a message that names the plan to upgrade to.",
    goalBy: "orchestrator",
    acceptance: ["Creating the 4th project on Free is refused with the upgrade hint"],
    decisions: ["Limits live in code (plans.ts), not in the database"],
    files: ["src/billing/plans.ts"],
    facts: ["~Free has 1 seat and 2 projects", "Free has 1 seat and 3 projects", "Team has 10 seats and unlimited projects"],
    age: 20,
  },
  {
    title: "Email: password reset links",
    status: "done",
    goal: "Send reset links that expire after an hour and can be used once.",
    outcome: "Reset tokens are hashed at rest, expire after 60 minutes and are deleted on use.",
    facts: ["Reset links expire after 60 minutes", "Reset tokens are stored hashed (SHA-256)"],
    age: 22,
  },
  {
    title: "Migrate tool: dry run",
    status: "done",
    goal: "Add --dry-run to tools/migrate that prints the SQL it would run.",
    outcome: "--dry-run prints each pending migration with its checksum and exits 0.",
    files: ["tools/migrate/main.go"],
    facts: ["The migrate tool is written in Go", "Migrations are checksummed with SHA-256"],
    age: 24,
  },
  {
    title: "Observability: request ids",
    status: "done",
    goal: "Give each request an id, return it in X-Request-Id and put it in every log line.",
    outcome: "Done with Fastify's genReqId; the dashboard shows the id on error toasts.",
    facts: ["Request ids are UUID v7", "The header is X-Request-Id"],
    age: 26,
  },
  {
    title: "Dropped: GraphQL gateway",
    status: "dropped",
    goal: "Evaluate putting a GraphQL gateway in front of the REST API for the dashboard.",
    decisions: ["Not worth it: the dashboard's 14 screens map to 22 REST calls"],
    outcome: "Dropped after the evaluation; REST stays.",
    facts: ["The dashboard makes 22 distinct REST calls"],
    age: 28,
  },
  {
    title: "Invoices: PDF rendering",
    status: "open",
    goal: "Render invoice PDFs on demand and cache them for 24 hours.",
    goalBy: "digest",
    constraints: ["No headless browser in the API image"],
    decisions: ["Render with pdfkit in a worker"],
    facts: ["~PDFs are cached for 7 days", "PDFs are cached for 24 hours", "The PDF worker runs in its own container"],
    age: 30,
  },
  {
    title: "Multi-currency prices",
    status: "open",
    goal: "Show prices in EUR and GBP from Stripe prices, not a conversion.",
    goalBy: "harness",
    facts: ["Prices come from Stripe Price objects per currency", "Currency is chosen from the billing address"],
    age: 32,
  },
  {
    title: "Account deletion",
    status: "done",
    goal: "Delete an account and its data within 30 days of the request, keeping invoices for tax law.",
    outcome: "Soft delete now, hard delete by a nightly job after 30 days; invoices are kept 10 years.",
    facts: ["Invoices are kept for 10 years", "Hard deletion runs nightly at 03:00 UTC"],
    age: 34,
  },
  {
    title: "SSO with Google Workspace",
    status: "open",
    goal: "Let Team accounts sign in with Google Workspace (OIDC), with domain restriction.",
    goalBy: "orchestrator",
    constraints: ["No new dependency beyond jose"],
    acceptance: ["A user outside the allowed domain is refused with a clear message"],
    facts: ["SSO is for the Team plan only", "Allowed domains are set per account"],
    age: 36,
  },
  {
    title: "Load test of /auth/refresh",
    status: "done",
    goal: "Measure /auth/refresh under 500 rps after the rotation change.",
    outcome: "p95 31 ms, p99 58 ms at 500 rps on one instance; no lock waits.",
    facts: ["~p95 of /auth/refresh is 44 ms", "p95 of /auth/refresh is 31 ms at 500 rps"],
    age: 38,
  },
  {
    title: "Docs: architecture overview",
    status: "done",
    goal: "Bring docs/architecture.md up to date with the worker split.",
    outcome: "docs/architecture.md describes API, workers and the PDF worker with one diagram.",
    files: ["docs/architecture.md"],
    facts: ["There are three deployables: API, workers, PDF worker"],
    age: 40,
  },
  {
    title: "Feature flags",
    status: "dropped",
    goal: "Add a feature flag service.",
    outcome: "Dropped: environment variables per deploy are enough for now.",
    facts: ["Feature switches are environment variables"],
    age: 42,
  },
  {
    title: "Trial expiry emails",
    status: "done",
    goal: "Email trial accounts 3 days and 1 day before the trial ends.",
    outcome: "Two scheduled emails; unsubscribing from marketing does not stop them.",
    facts: ["~Trials last 30 days", "Trials last 14 days"],
    age: 44,
  },
  {
    title: "Backups: point-in-time recovery",
    status: "done",
    goal: "Confirm PITR works by restoring yesterday's database into staging.",
    outcome: "Restored to 02:00 UTC into staging in 11 minutes.",
    facts: ["PITR window is 7 days", "A full restore takes about 11 minutes"],
    age: 46,
  },
  {
    title: "Error budget for the API",
    status: "open",
    goal: "Agree an availability target and alert on burn rate.",
    goalBy: "harness",
    facts: ["The availability target is 99.9% monthly"],
    age: 48,
  },
  {
    title: "Dependency updates (monthly)",
    status: "done",
    goal: "Update dependencies and note anything that needed code changes.",
    outcome: "jose 6.0.8 and postgres 3.4.5; nothing needed code changes.",
    facts: ["jose is on 6.0.8", "postgres.js is on 3.4.5"],
    age: 50,
  },
  {
    title: "Support: impersonation",
    status: "dropped",
    goal: "Let support sign in as a user to reproduce problems.",
    outcome: "Dropped by the owner: read-only views in the admin dashboard instead.",
    facts: ["Support never signs in as a user"],
    age: 52,
  },
  {
    title: "Web origin and CORS",
    status: "done",
    goal: "Allow only the dashboard's origin, with credentials.",
    outcome: "CORS allows WEB_ORIGIN only; preflight cached for 10 minutes.",
    files: ["src/http/cors.ts"],
    facts: ["~The dashboard runs on port 3000 in development", "The dashboard runs on port 5173 in development"],
    age: 54,
  },
  {
    title: "Test database per worker",
    status: "done",
    goal: "Make the test suite run in parallel with one database per vitest worker.",
    outcome: "Each worker creates atlas_test_<n> from a template; the suite runs in 38 s instead of 2 min.",
    facts: ["The test suite runs in about 38 s", "Test databases are created from a template"],
    age: 57,
  },
  {
    title: "Project kickoff: scope of the first month",
    status: "done",
    goal: "Agree what the orchestrator owns in this project and how the owner wants to be asked.",
    decisions: ["Ask before touching billing code", "Summaries in English, short"],
    outcome: "Scope: auth, billing, CI. The owner reviews every migration before it runs.",
    facts: ["The owner reviews every migration before it runs", "The owner tests on Linux"],
    age: 60,
  },
];

/** A fact superseded by a fact of another task: [task index, fact index] → [task index, fact index]. */
export const CROSS_SUPERSEDES: [[number, number], [number, number]][] = [
  [
    [19, 1],
    [0, 5],
  ],
];

/** More facts, appended to a task's list (dated after its own). */
export const EXTRA_FACTS: Record<number, string[]> = {
  0: ["p95 of /auth/refresh is 36 ms with family revocation", "The family id is the first token's id"],
  1: ["Counters are pruned every 10 minutes", "A successful login resets the account counter"],
  2: ["Unknown event types are acknowledged and ignored", "The handler answers within 2 s; work is queued"],
  3: ["The dashboard keeps the cursor in the URL"],
  9: ["Audit rows carry the request id", "The actor is a user id or the word system"],
  10: ["Downgrading over the limit keeps data read-only"],
  15: ["PDF file names are invoice-<number>.pdf"],
  16: ["EUR prices include VAT, GBP prices do not"],
  18: ["Google is the only SSO provider for now"],
  24: ["Burn-rate alerts go to the owner's email"],
};

export type FileSpec = { path: string; summary: string; content: string; age: number };

export const FILES: FileSpec[] = [
  {
    path: "architecture.md",
    summary: "API, workers and the PDF worker; how they talk",
    age: 3,
    content: `# Architecture\n\nThree deployables share one Postgres database:\n\n- **API** (Fastify 5): auth, billing, accounts. Pool of 20.\n- **Workers**: webhooks, emails, nightly jobs. Pool of 5.\n- **PDF worker**: renders invoices with pdfkit, cached 24 h.\n\nAll three read configuration from the environment only.\n`,
  },
  {
    path: "decisions/auth.md",
    summary: "Why tokens rotate, family revocation, lifetimes",
    age: 2,
    content: `# Auth decisions\n\n- Access tokens: 15 minutes, HS256, signed with JWT_SECRET.\n- Refresh tokens: 30 days, rotated on every use.\n- A replayed refresh token revokes its whole family (the owner asked for this on day 58).\n- Families are a parent id column, not a table.\n`,
  },
  {
    path: "decisions/billing.md",
    summary: "Stripe as the source of truth; idempotent webhooks",
    age: 6,
    content: `# Billing decisions\n\n- Stripe is the source of truth for prices, subscriptions and invoices.\n- Webhooks are idempotent through a unique index on the event id.\n- Prices per currency come from Stripe; no conversion.\n`,
  },
  {
    path: "owner.md",
    summary: "How the owner likes to work and be asked",
    age: 60,
    content: `# Owner\n\n- Tests on Linux.\n- Reviews every migration before it runs.\n- Wants short English summaries and a question before billing code changes.\n- Prefers one PR per task.\n`,
  },
  {
    path: "runbooks/deploy.md",
    summary: "Deploy steps, order and rollback",
    age: 12,
    content: `# Deploy\n\n1. Run migrations with \`tools/migrate --dry-run\` first; the owner approves.\n2. Deploy workers, then the API, then the PDF worker.\n3. Roll back by redeploying the previous image; migrations are forward-only.\n`,
  },
  {
    path: "runbooks/incident.md",
    summary: "What to do when the API is down or slow",
    age: 20,
    content: `# Incident\n\n- Check the pool first (connections waiting).\n- Request ids are in every log line (X-Request-Id).\n- PITR covers 7 days; a full restore takes about 11 minutes.\n`,
  },
  {
    path: "security/threat-model.md",
    summary: "Token theft, replay, what limits the damage",
    age: 15,
    content: `# Threat model (summary)\n\n- Stolen access token: 15 minutes at most.\n- Stolen refresh token: one use; a replay revokes the family.\n- Webhook spoofing: signature check with STRIPE_WEBHOOK_SECRET.\n`,
  },
  {
    path: "glossary.md",
    summary: "Words used in this project and what they mean",
    age: 40,
    content: `# Glossary\n\n- **Family**: the chain of refresh tokens issued from one login.\n- **Seat**: a member of a Team account.\n- **PITR**: point-in-time recovery of the database.\n`,
  },
  {
    path: "testing.md",
    summary: "Test databases, how to run the suite fast",
    age: 57,
    content: `# Testing\n\nOne database per vitest worker (template database), ~38 s for the whole suite.\nRun \`pnpm test\`; \`test/helpers/server.ts\` builds the app.\n`,
  },
  {
    path: "plans.md",
    summary: "Plan limits and what each plan includes",
    age: 20,
    content: `# Plans\n\n| Plan | Seats | Projects |\n| --- | --- | --- |\n| Free | 1 | 3 |\n| Team | 10 | unlimited |\n\nLimits live in src/billing/plans.ts.\n`,
  },
  {
    path: "open-questions.md",
    summary: "Things to ask the owner next time",
    age: 1,
    content: `# Open questions\n\n- Should SSO users be able to have a password too?\n- Error budget: alert on 2% or 5% burn per hour?\n- Do EUR invoices need a VAT line before December?\n`,
  },
  {
    path: "ci.md",
    summary: "CI jobs, toolchains and caches",
    age: 9,
    content: `# CI\n\n- Node 22, pnpm 10.\n- Rust 1.88 for tools/migrate, target/ cached.\n- The migrate job takes about 1 min 40 s.\n`,
  },
];
