import type { ReviewFileStatus, ReviewGroup } from "@octo/agent-client";

/** One changed file of a demo review: both texts are kept so the diff API can answer at any context. */
export type DemoReviewFile = {
  path: string;
  old_path?: string;
  status: ReviewFileStatus;
  before: string | null;
  after: string | null;
  group: ReviewGroup;
  reason: string;
  binary?: boolean;
  image?: string;
  /** Overrides the byte sizes (binary and image files have no text). */
  sizes?: { old: number; new: number };
  tooLarge?: { added: number; removed: number };
  similarity?: number;
  /** Starts as viewed / as "changed since viewed". */
  viewed?: boolean;
  changedSinceViewed?: boolean;
  changedSinceSubmitted?: boolean;
};

const CLIENT_BEFORE = `import { BillingError } from "./errors";
import type { Charge, ChargeRequest } from "./types";

const BASE_URL = process.env.BILLING_URL ?? "https://billing.internal";

export async function createCharge(req: ChargeRequest): Promise<Charge> {
  const res = await fetch(\`\${BASE_URL}/v2/charges\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${req.token}\` },
    body: JSON.stringify({ amount: req.amount, currency: req.currency, customer: req.customer }),
  });
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
  return (await res.json()) as Charge;
}

export async function refundCharge(id: string): Promise<void> {
  const res = await fetch(\`\${BASE_URL}/v2/charges/\${id}/refund\`, { method: "POST" });
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
}

export async function getCharge(id: string): Promise<Charge> {
  const res = await fetch(\`\${BASE_URL}/v2/charges/\${id}\`);
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
  return (await res.json()) as Charge;
}
`;

const CLIENT_AFTER = `import { BillingError } from "./errors";
import { withRetry } from "./retry";
import type { Charge, ChargeRequest } from "./types";

const BASE_URL = process.env.BILLING_URL ?? "https://billing.internal";

async function send(url: string, init: RequestInit): Promise<Response> {
  return withRetry(async () => {
    const res = await fetch(url, init);
    if (res.status >= 500) {
      throw new BillingError(res.status, await res.text(), { retryAfter: res.headers.get("retry-after") });
    }
    return res;
  });
}

export async function createCharge(req: ChargeRequest): Promise<Charge> {
  const res = await send(\`\${BASE_URL}/v2/charges\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${req.token}\` },
    body: JSON.stringify({ amount: req.amount, currency: req.currency, customer: req.customer }),
  });
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
  return (await res.json()) as Charge;
}

export async function refundCharge(id: string): Promise<void> {
  const res = await send(\`\${BASE_URL}/v2/charges/\${id}/refund\`, { method: "POST" });
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
}

export async function getCharge(id: string): Promise<Charge> {
  const res = await fetch(\`\${BASE_URL}/v2/charges/\${id}\`);
  if (!res.ok) {
    throw new BillingError(res.status, await res.text());
  }
  return (await res.json()) as Charge;
}
`;

const RETRY_AFTER = `import { BillingError } from "./errors";

export type RetryPolicy = { attempts: number; baseMs: number; maxMs: number };

export const DEFAULT_POLICY: RetryPolicy = { attempts: 4, baseMs: 200, maxMs: 5000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds from a Retry-After header; the HTTP-date form is not handled. */
function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Exponential backoff with full jitter. */
function delayFor(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

export async function withRetry<T>(run: () => Promise<T>, policy: RetryPolicy = DEFAULT_POLICY): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      return await run();
    } catch (e) {
      last = e;
      if (!(e instanceof BillingError) || !e.transient) throw e;
      const hinted = retryAfterMs(e.retryAfter);
      await sleep(hinted ?? delayFor(attempt, policy));
    }
  }
  throw last;
}
`;

const ERRORS_BEFORE = `export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(\`billing responded \${status}\`);
    this.name = "BillingError";
  }
}
`;

const ERRORS_AFTER = `export class BillingError extends Error {
  readonly retryAfter: string | null;

  constructor(
    readonly status: number,
    readonly body: string,
    opts: { retryAfter?: string | null } = {},
  ) {
    super(\`billing responded \${status}\`);
    this.name = "BillingError";
    this.retryAfter = opts.retryAfter ?? null;
  }

  /** A 5xx the billing service may recover from on its own. */
  get transient(): boolean {
    return this.status >= 500 && this.status !== 501;
  }
}
`;

const MONEY_BEFORE = `export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatAmount(cents: number, currency: string): string {
  return \`\${fromCents(cents).toFixed(2)} \${currency}\`;
}
`;

const MONEY_AFTER = `/** Whole minor units (cents) for a decimal amount; rounds half away from zero. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatAmount(cents: number, currency: string): string {
  return \`\${fromCents(cents).toFixed(2)} \${currency.toUpperCase()}\`;
}
`;

const EXPORT_BEFORE = `import { getCharge } from "../billing/client";

export async function exportInvoice(id: string): Promise<string> {
  const charge = await getCharge(id);
  return [id, charge.amount, charge.currency].join(",");
}
`;

const EXPORT_AFTER = `import { getCharge } from "../billing/client";
import { BillingError } from "../billing/errors";

export async function exportInvoice(id: string): Promise<string> {
  try {
    const charge = await getCharge(id);
    return [id, charge.amount, charge.currency].join(",");
  } catch (e) {
    if (e instanceof BillingError && e.transient) return \`\${id},unavailable\`;
    throw e;
  }
}
`;

const CHARGE_BEFORE = `import { createCharge } from "../billing/client";
import { toCents } from "../billing/util";

export async function charge(customer: string, amount: number, token: string) {
  return createCharge({ customer, amount: toCents(amount), currency: "usd", token });
}
`;

const CHARGE_AFTER = `import { createCharge } from "../billing/client";
import { toCents } from "../billing/money";

export async function charge(customer: string, amount: number, token: string) {
  return createCharge({ customer, amount: toCents(amount), currency: "usd", token });
}
`;

const RETRY_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { BillingError } from "./errors";
import { withRetry } from "./retry";

const policy = { attempts: 3, baseMs: 1, maxMs: 2 };

test("retries a transient error and then succeeds", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new BillingError(503, "busy");
    return "ok";
  }, policy);
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("does not retry a 4xx", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new BillingError(402, "declined");
    }, policy),
  );
  assert.equal(calls, 1);
});
`;

const CLIENT_TEST_BEFORE = `import assert from "node:assert/strict";
import { test } from "node:test";
import { createCharge } from "./client";

test("createCharge posts the amount", async () => {
  const seen: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: "ch_1" }), { status: 200 });
  }) as typeof fetch;
  await createCharge({ amount: 1250, currency: "usd", customer: "cus_1", token: "t" });
  assert.deepEqual(seen, [{ amount: 1250, currency: "usd", customer: "cus_1" }]);
});
`;

const CLIENT_TEST_AFTER = `${CLIENT_TEST_BEFORE}
test("createCharge survives one 503", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ id: "ch_2" }), { status: 200 });
  }) as typeof fetch;
  const charge = await createCharge({ amount: 100, currency: "usd", customer: "cus_1", token: "t" });
  assert.equal(charge.id, "ch_2");
  assert.equal(calls, 2);
});
`;

const DOCS_BEFORE = `# Billing client

The billing client talks to the internal billing service.

## Errors

Any non-2xx response throws a \`BillingError\` with the status and the body.
`;

const DOCS_AFTER = `# Billing client

The billing client talks to the internal billing service.

## Errors

Any non-2xx response throws a \`BillingError\` with the status and the body.

## Retries

Charges and refunds retry on a 5xx (except 501) up to four times with exponential backoff and full jitter.
A \`Retry-After\` header in seconds overrides the computed delay. Reads (\`getCharge\`) do not retry yet.
`;

const GENERATED_BEFORE = `// Code generated by protoc-gen-ts. DO NOT EDIT.
export interface Charge {
  id: string;
  amount: number;
  currency: string;
}
`;

const GENERATED_AFTER = `// Code generated by protoc-gen-ts. DO NOT EDIT.
export interface Charge {
  id: string;
  amount: number;
  currency: string;
  retried?: number;
}
`;

/** The review of #482: fourteen files across the groups, with an image, a binary file, a rename and a file too large to show. */
export const BILLING_FILES: DemoReviewFile[] = [
  { path: "src/billing/client.ts", status: "modified", before: CLIENT_BEFORE, after: CLIENT_AFTER, group: "core", reason: "core" },
  { path: "src/billing/retry.ts", status: "added", before: null, after: RETRY_AFTER, group: "core", reason: "core" },
  { path: "src/billing/errors.ts", status: "modified", before: ERRORS_BEFORE, after: ERRORS_AFTER, group: "core", reason: "core", viewed: true },
  {
    path: "src/billing/money.ts",
    old_path: "src/billing/util.ts",
    status: "renamed",
    before: MONEY_BEFORE,
    after: MONEY_AFTER,
    group: "core",
    reason: "core",
    similarity: 78,
  },
  {
    path: "src/invoices/export.ts",
    status: "modified",
    before: EXPORT_BEFORE,
    after: EXPORT_AFTER,
    group: "callers",
    reason: "caller",
    changedSinceViewed: true,
  },
  { path: "src/api/charge.ts", status: "modified", before: CHARGE_BEFORE, after: CHARGE_AFTER, group: "callers", reason: "caller" },
  { path: "src/billing/retry.test.ts", status: "added", before: null, after: RETRY_TEST, group: "tests", reason: "test" },
  { path: "src/billing/client.test.ts", status: "modified", before: CLIENT_TEST_BEFORE, after: CLIENT_TEST_AFTER, group: "tests", reason: "test" },
  { path: "docs/billing.md", status: "modified", before: DOCS_BEFORE, after: DOCS_AFTER, group: "other", reason: "docs" },
  {
    path: "docs/img/retry-flow.png",
    status: "modified",
    before: null,
    after: null,
    group: "other",
    reason: "asset",
    image: "image/png",
    binary: true,
    sizes: { old: 18_432, new: 21_760 },
  },
  { path: "data/rates.bin", status: "modified", before: null, after: null, group: "other", reason: "asset", binary: true, sizes: { old: 12_288, new: 14_336 } },
  { path: "pnpm-lock.yaml", status: "modified", before: null, after: null, group: "mechanical", reason: "lockfile", tooLarge: { added: 1204, removed: 980 } },
  { path: "src/generated/billing.ts", status: "modified", before: GENERATED_BEFORE, after: GENERATED_AFTER, group: "mechanical", reason: "generated" },
  {
    path: "src/billing/types.ts",
    old_path: "src/billing/model.ts",
    status: "renamed",
    before: "export type Charge = { id: string; amount: number; currency: string };\n",
    after: "export type Charge = { id: string; amount: number; currency: string };\n",
    group: "mechanical",
    reason: "rename",
    similarity: 100,
  },
];

const LIMITER_BEFORE = `export function limit(n: number, windowMs: number) {
  const hits: number[] = [];
  return (now: number) => {
    while (hits.length && hits[0]! <= now - windowMs) hits.shift();
    if (hits.length >= n) return false;
    hits.push(now);
    return true;
  };
}
`;

const LIMITER_AFTER = `export function limit(n: number, windowMs: number) {
  const hits: number[] = [];
  return (now: number) => {
    while (hits.length && hits[0]! < now - windowMs) hits.shift();
    if (hits.length >= n) return false;
    hits.push(now);
    return true;
  };
}
`;

const LIMITER_TEST_BEFORE = `import assert from "node:assert/strict";
import { test } from "node:test";
import { limit } from "./limiter";

test("allows n hits per window", () => {
  const ok = limit(2, 1000);
  assert.ok(ok(0));
  assert.ok(ok(1));
  assert.ok(!ok(2));
});
`;

const LIMITER_TEST_AFTER = `${LIMITER_TEST_BEFORE}
test("a hit exactly one window old still counts", () => {
  const ok = limit(1, 1000);
  assert.ok(ok(0));
  assert.ok(!ok(1000));
  assert.ok(ok(1001));
});
`;

const CHANGELOG_BEFORE = "# Changelog\n\n## 0.9.0\n\n- Usage window is configurable.\n";
const CHANGELOG_AFTER =
  "# Changelog\n\n## Unreleased\n\n- Fix the usage window boundary (a hit exactly one window old counts).\n\n## 0.9.0\n\n- Usage window is configurable.\n";

/** The review of every other pull request and of local branches: three small files. */
export const SMALL_FILES: DemoReviewFile[] = [
  { path: "src/usage/limiter.ts", status: "modified", before: LIMITER_BEFORE, after: LIMITER_AFTER, group: "core", reason: "core" },
  { path: "src/usage/limiter.test.ts", status: "modified", before: LIMITER_TEST_BEFORE, after: LIMITER_TEST_AFTER, group: "tests", reason: "test" },
  { path: "CHANGELOG.md", status: "modified", before: CHANGELOG_BEFORE, after: CHANGELOG_AFTER, group: "other", reason: "docs" },
];
