/** Seed content for the demo file system; loaded lazily on first file access. */
import type { DemoFile } from "./store";

type Seed = Record<string, string | { binary: true } | { size: number }>;

/** Width-stability fixtures (decision 79): a 20-column file, a 400-column file and a one-line minified bundle. */
const narrowLines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: short`).join("\n");
const wideLines = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3, "0")} ` + "0123456789 ".repeat(36)).join("\n");
const minified =
  "!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}" +
  "n.d=function(e,t,r){n.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:r})};".repeat(40);

const ATLAS_API: Seed = {
  "width/narrow.txt": `${narrowLines}\n`,
  "width/wide.txt": `${wideLines}\n`,
  "width/minified.js": minified,
  ".gitignore": "node_modules/\ndist/\n.env\ncoverage/\n",
  ".env.example": "DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas\nJWT_SECRET=change-me\nWEB_ORIGIN=http://localhost:5173\n",
  "README.md": `# atlas-api

Accounts and billing service behind the Atlas dashboard.

## Develop

\`\`\`sh
pnpm install
cp .env.example .env
pnpm dev
\`\`\`

## Auth

- Access tokens live for **15 minutes**.
- Refresh tokens rotate on every use and live for **30 days**.
- See \`docs/security.md\` for the threat model.
`,
  "package.json": `{
  "name": "atlas-api",
  "version": "2.14.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^5.2.1",
    "jose": "^6.0.8",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
`,
  "tsconfig.json": `{
  // Strict everywhere; the build emits ESM for Node 22.
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src"]
}
`,
  "src/index.ts": `import Fastify from "fastify";
import { authRoutes } from "./auth/routes";
import { requireAuth } from "./http/middleware/auth";
import { cors } from "./http/cors";

const app = Fastify({ logger: true });

await app.register(cors);
app.addHook("onRequest", requireAuth({ except: ["/auth/"] }));
await app.register(authRoutes, { prefix: "/auth" });

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
`,
  "src/auth/login.ts": `import { db } from "../db";
import { verifyPassword } from "./password";
import { issuePair } from "./tokens";

export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function login(email: string, password: string) {
  const user = await db.users.byEmail(email.trim().toLowerCase());
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new AuthError("invalid_credentials");
  }
  return issuePair(user.id);
}
`,
  "src/auth/refresh.ts": `import { db } from "../db";
import { AuthError } from "./login";
import { issuePair, verifyRefresh } from "./tokens";

/**
 * Rotates a refresh token: the presented token is revoked and a new pair is issued.
 * Two tabs refreshing at once both present the same token; the second one loses.
 */
export async function refresh(raw: string) {
  const token = await verifyRefresh(raw);
  if (token.revokedAt) throw new AuthError("refresh_revoked");
  await db.refreshTokens.revoke(token.id);
  return issuePair(token.userId);
}
`,
  "src/auth/tokens.ts": `import { SignJWT, jwtVerify } from "jose";
import { db } from "../db";

export const ACCESS_TTL = 15 * 60; // seconds
export const REFRESH_TTL = 30 * 24 * 3600;

const secret = new TextEncoder().encode(process.env.JWT_SECRET);

export async function issuePair(userId: string) {
  const access = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(\`\${ACCESS_TTL}s\`)
    .sign(secret);
  const refresh = await db.refreshTokens.create(userId, REFRESH_TTL);
  return { access, refresh: refresh.raw, expiresIn: ACCESS_TTL };
}

export async function verifyRefresh(raw: string) {
  const token = await db.refreshTokens.byRaw(raw);
  if (!token || token.expiresAt < new Date()) throw new Error("refresh_invalid");
  return token;
}

export async function verifyAccess(jwt: string) {
  const { payload } = await jwtVerify(jwt, secret);
  return payload.sub as string;
}
`,
  "src/http/middleware/auth.ts": `import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccess } from "../../auth/tokens";

export function requireAuth(options: { except: string[] }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.except.some((prefix) => req.url.startsWith(prefix))) return;
    const header = req.headers.authorization ?? "";
    const jwt = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      req.userId = await verifyAccess(jwt);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}
`,
  "src/http/cookies.ts": `export const refreshCookie = {
  name: "atlas_rt",
  options: { httpOnly: true, sameSite: "lax", path: "/auth", secure: true },
} as const;
`,
  "src/http/cors.ts": `import fastifyCors from "@fastify/cors";

export const cors = [fastifyCors, { origin: [process.env.WEB_ORIGIN], credentials: true }] as const;
`,
  "src/db/index.ts": `import postgres from "postgres";
import { refreshTokens } from "./refreshTokens";
import { users } from "./users";

const sql = postgres(process.env.DATABASE_URL!);

export const db = {
  users: users(sql),
  refreshTokens: refreshTokens(sql),
};
`,
  "test/helpers/server.ts": `import { buildApp } from "../../src/app";

export async function testServer() {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}
`,
  "test/auth/refresh.test.ts": `import { describe, expect, it } from "vitest";
import { testServer } from "../helpers/server";

describe("POST /auth/refresh", () => {
  it("rotates the refresh token", async () => {
    const app = await testServer();
    const first = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { atlas_rt: "seed" } });
    expect(first.statusCode).toBe(200);
  });
});
`,
  "test/fixtures/events.ndjson": { size: 3_481_204 },
  "tools/migrate/go.mod": "module github.com/atlas/migrate\n\ngo 1.24\n\nrequire github.com/jackc/pgx/v5 v5.7.2\n",
  "tools/migrate/main.go": `package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Applies every *.sql file in ./migrations that is not yet recorded.
func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	files, err := os.ReadDir("migrations")
	if err != nil {
		log.Fatal(err)
	}
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, f.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		applied, err := isApplied(ctx, conn, name)
		if err != nil {
			log.Fatal(err)
		}
		if applied {
			continue
		}
		fmt.Printf("applying %s\\n", name)
	}
}

func isApplied(ctx context.Context, conn *pgx.Conn, name string) (bool, error) {
	var n int
	err := conn.QueryRow(ctx, "select count(*) from schema_migrations where name = $1", name).Scan(&n)
	return n > 0, err
}
`,
  "docs/architecture.md": `# Architecture

How a request moves through **atlas-api**, from the edge to Postgres. Read [the security notes](security.md)
first if you are changing anything under \`src/auth/\`.

![Request flow](./diagrams/request-flow.png)

## Layers

| Layer | Where | Owns |
| --- | --- | --- |
| HTTP | \`src/http/\` | Routing, CORS, cookies, the auth middleware |
| Auth | \`src/auth/\` | Login, token issue and rotation, refresh |
| Data | \`src/db/\` | The Postgres pool and typed queries |
| Tools | \`tools/migrate/\` | Schema migrations (Go) |

## Requests

1. The edge terminates TLS and forwards to Fastify on port 8080.
2. [\`requireAuth\`](../src/http/middleware/auth.ts) checks the access token on every route except \`/auth/*\`.
3. Handlers call into \`src/auth\` or \`src/db\`; nothing else touches the pool.

### Tokens

- Access tokens are JWTs, valid for **15 minutes**.
- Refresh tokens are opaque, stored hashed, valid for **30 days**, and rotate on every use.
- A reused refresh token revokes the whole family (see [refresh.ts](../src/auth/refresh.ts)).

\`\`\`ts
export const ACCESS_TTL = 15 * 60; // seconds
export const REFRESH_TTL = 30 * 24 * 3600;
\`\`\`

## Errors

Every error is \`{ code, message }\` with a stable \`code\`. Clients branch on the code, never on the message.

> A \`401\` from \`/auth/refresh\` with \`refresh_reused\` means the session is gone; any other \`401\` there is
> worth one retry.

## Testing

Unit tests live next to the code they cover; integration tests under \`test/\` start a real server with
[the test helper](../test/helpers/server.ts) against a throwaway database.

## Deploying

1. Merge to \`main\`; CI runs the tests and builds the image.
2. The migration job runs before the new pods take traffic.
3. Roll back by redeploying the previous image; migrations are always backwards compatible for one release.

## Open questions

- Should refresh rotation get a grace window for concurrent tabs?
- Do we move cookies to \`SameSite=strict\` once the web app is on the same site?
`,
  "docs/security.md": `# Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| Refresh token | Theft via XSS | httpOnly cookie scoped to \`/auth\` |
| Refresh token | Replay after theft | Rotation on every use |
| Access token | Long-lived leak | 15 minute lifetime |

Open question: a grace window for concurrent refreshes.
`,
};

const ATLAS_WEB: Seed = {
  "README.md": "# atlas-web\n\nDashboard for Atlas accounts and billing. `pnpm dev` starts Vite on port 5173.\n",
  "package.json": `{
  "name": "atlas-web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },
  "devDependencies": { "typescript": "^5.7.3", "vite": "^6.1.0" }
}
`,
  "vite.config.ts": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8080" } },
});
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.svg" />
    <title>Atlas</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
  "src/lib/session.ts": `import { http } from "./http";

let accessToken: string | null = null;
let expiresAt = 0;

/** Refreshes 60 s before the access token expires. Runs independently in every tab. */
export async function ensureFresh(): Promise<string | null> {
  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
  const res = await http.post<{ access: string; expiresIn: number }>("/auth/refresh");
  accessToken = res.access;
  expiresAt = Date.now() + res.expiresIn * 1000;
  return accessToken;
}

export const session = {
  clear() {
    accessToken = null;
    expiresAt = 0;
    location.assign("/login");
  },
};
`,
  "src/lib/http.ts": `import { session } from "./session";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(\`/api\${url}\`, {
    method,
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) session.clear();
  if (!res.ok) throw new Error(\`\${method} \${url} → \${res.status}\`);
  return (await res.json()) as T;
}

export const http = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
};
`,
  "src/sw.ts": `/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

// The service worker also refreshes on push wake-up.
self.addEventListener("push", (event) => {
  event.waitUntil(fetch("/api/auth/refresh", { method: "POST", credentials: "include" }));
});
`,
  "src/styles.css": `:root {
  --surface: #ffffff;
  --text: #1c1c1c;
  --muted: #6b6b6b;
  --radius: 8px;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
}

.card {
  border: 1px solid rgb(0 0 0 / 0.08);
  border-radius: var(--radius);
  padding: 16px 20px;
}

.card h2 {
  margin: 0 0 8px;
  font-size: 15px;
}
`,
  "public/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#1c1c1c"/></svg>\n',
  "public/logo.png": { binary: true },
  "public/mark.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect x="8" y="8" width="80" height="80" rx="18" fill="#3b6ed8"/><path d="M28 60 L48 28 L68 60 Z" fill="#f2b13c"/><circle cx="48" cy="66" r="6" fill="#ffffff"/><script>document.title = "svg script ran"</script></svg>\n',
  "public/hero.jpg": { size: 3_400_000 },
};

const ORBIT_APP: Seed = {
  "README.md": "# Orbit\n\nReact Native client for iOS and Android.\n\n- `yarn ios` / `yarn android`\n- `yarn jest` runs the unit tests\n",
  "package.json": `{
  "name": "orbit-app",
  "version": "4.2.0",
  "private": true,
  "scripts": {
    "android": "react-native run-android",
    "ios": "react-native run-ios",
    "test": "jest"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-native": "0.76.5",
    "react-native-maps": "1.10.3",
    "@orbit/native-camera": "workspace:*"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "typescript": "^5.6.3"
  }
}
`,
  "metro.config.js": `const { getDefaultConfig } = require("metro-config");

module.exports = (async () => {
  const defaults = await getDefaultConfig();
  return {
    transformer: {
      babelTransformerPath: require.resolve("react-native-svg-transformer"),
    },
    resolver: {
      assetExts: defaults.resolver.assetExts.filter((ext) => ext !== "svg"),
      sourceExts: [...defaults.resolver.sourceExts, "svg"],
    },
  };
})();
`,
  "babel.config.js": 'module.exports = {\n  presets: ["module:@react-native/babel-preset"],\n};\n',
  "App.tsx": `import { NavigationContainer } from "@react-navigation/native";
import { SyncProvider } from "./src/sync/SyncProvider";
import { RootStack } from "./src/navigation/RootStack";

export default function App() {
  return (
    <SyncProvider>
      <NavigationContainer>
        <RootStack />
      </NavigationContainer>
    </SyncProvider>
  );
}
`,
  "android/build.gradle": `buildscript {
    ext {
        buildToolsVersion = "35.0.0"
        minSdkVersion = 23
        compileSdkVersion = 35
        targetSdkVersion = 34
        ndkVersion = "26.1.10909125"
        kotlinVersion = "1.9.24"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin")
    }
}

apply plugin: "com.facebook.react.rootproject"
`,
  "android/app/build.gradle": `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

android {
    namespace "app.orbit"
    defaultConfig {
        applicationId "app.orbit"
        versionCode 4200
        versionName "4.2.0"
    }
}
`,
  "android/app/proguard-rules.pro": "-keep class app.orbit.camera.** { *; }\n",
  "ios/Podfile": "platform :ios, '15.1'\n\ntarget 'Orbit' do\n  config = use_native_modules!\n  use_react_native!(:path => config[:reactNativePath])\nend\n",
  "src/sync/retry.ts": `export function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt + 1 >= attempts) throw e;
      await new Promise((r) => setTimeout(r, backoff(attempt)));
    }
  }
}
`,
  "src/sync/queue.ts": `import { withRetry } from "./retry";

type Job = { id: string; run(): Promise<void> };

export class SyncQueue {
  private jobs: Job[] = [];
  private running = false;

  push(job: Job) {
    this.jobs.push(job);
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length) {
      const job = this.jobs.shift()!;
      await withRetry(() => job.run());
    }
    this.running = false;
  }
}
`,
  "src/sync/__tests__/sync.queue.test.ts": `import { SyncQueue } from "../queue";

jest.useFakeTimers();

test("drains jobs in order", async () => {
  const seen: string[] = [];
  const q = new SyncQueue();
  q.push({ id: "a", run: async () => void seen.push("a") });
  q.push({ id: "b", run: async () => void seen.push("b") });
  await jest.runAllTimersAsync();
  expect(seen).toEqual(["a", "b"]);
});
`,
  "assets/icon.png": { binary: true },
};

const DOCS_SITE: Seed = {
  "README.md": "# docs-site\n\nMarketing site and docs, built with Astro.\n",
  "package.json":
    '{\n  "name": "docs-site",\n  "private": true,\n  "scripts": { "dev": "astro dev", "build": "astro build" },\n  "dependencies": { "astro": "^5.2.0" }\n}\n',
  "astro.config.mjs": 'import { defineConfig } from "astro/config";\n\nexport default defineConfig({\n  site: "https://docs.example.com",\n});\n',
  "src/content/docs/getting-started.md":
    "---\ntitle: Getting started\n---\n\n# Getting started\n\nInstall the CLI, then sign in:\n\n```sh\nnpm i -g @example/cli\nexample login\n```\n",
  "src/styles/global.css": "html {\n  font-family: system-ui, sans-serif;\n  line-height: 1.6;\n}\n\nmain {\n  max-width: 720px;\n  margin: 0 auto;\n}\n",
};

/** Stress test: a dozen small files, very long names, one file wider than any editor. */
const STRESS_KIT: Seed = {
  ...Object.fromEntries(
    ["api", "auth", "billing", "cache", "clock", "config", "db", "events", "flags", "http", "logger", "queue"].map((n) => [
      `src/${n}.ts`,
      `// ${n}\nexport const ${n} = {\n  enabled: true,\n  name: "${n}",\n  retries: 3,\n};\n`,
    ]),
  ),
  "src/components/ConversationTranscriptVirtualizedListWithStickyHeadersAndKeyboardNavigation.tsx":
    "export function ConversationTranscriptVirtualizedListWithStickyHeadersAndKeyboardNavigation() {\n  return null;\n}\n",
  "docs/an-unusually-long-architecture-decision-record-about-retries-and-idempotency-keys.md":
    "# Retries and idempotency keys\n\nEvery write accepts an `Idempotency-Key` header.\n",
  "src/features/chat/transcript/virtual/rows/ListRow.tsx": "export function ListRow() {\n  return null;\n}\n",
  "src/wide.ts": `export const ALLOWED_ORIGINS = [${Array.from({ length: 14 }, (_, i) => `"https://tenant-${i + 1}.example.com"`).join(", ")}];\n`,
  "README.md": "# stress-kit\n\nFiles for layout stress tests.\n",
};

/** Payments ledger: the settlement job the showcase answer links to (lines 14–22 hold the rounding). */
const LEDGER: Seed = {
  "README.md": "# ledger\n\nSettlement batch jobs and the reconciliation report.\n",
  "jobs/settle.ts": `import { Money } from "../lib/money";
import type { Batch, Line } from "../lib/types";

/**
 * Nightly settlement for one region: sums every merchant's lines and writes one payout per merchant.
 * Runs at 02:00 UTC; a dry run prints the totals without writing.
 */
export type SettleOptions = { region: string; date: string; dryRun: boolean };

export async function settle(batch: Batch, options: SettleOptions) {
  if (batch.lines.length === 0) return Money.zero("EUR");
  // Rounds every line before summing: sub-cent fees drift.
  let sum = 0;
  for (const line of batch.lines) {
    sum += Math.round(line.amount * 100) / 100;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ merchants: batch.merchants, total: sum.toFixed(2) }));
  }
  return Money.of(sum, "EUR");
}

export function total(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.amount, 0);
}
`,
  "reports/eu.sql":
    "select merchant_id, sum(amount_minor) as total_minor\nfrom settlement_lines\nwhere region = 'eu' and settled_on = $1\ngroup by merchant_id\norder by merchant_id;\n",
  "cmd/reconcile/main.go":
    'package main\n\nimport "fmt"\n\ntype Line struct{ AmountMinor int64 }\n\nfunc total(lines []Line) int64 {\n\tvar sum int64\n\tfor _, l := range lines {\n\t\tsum += l.AmountMinor\n\t}\n\treturn sum\n}\n\nfunc main() { fmt.Println(total(nil)) }\n',
  "package.json": '{\n  "name": "ledger",\n  "private": true,\n  "scripts": { "settle": "tsx jobs/settle.ts" }\n}\n',
};

/** Infrastructure: Terraform modules and environment stacks. */
const INFRA: Seed = {
  "README.md": "# infra\n\nShared Terraform modules and the staging / production stacks.\n",
  "modules/node-pool/main.tf":
    'variable "name" {}\nvariable "size" { default = 3 }\n\nresource "google_container_node_pool" "node_pool" {\n  name       = var.name\n  node_count = var.size\n}\n',
  "envs/staging/main.tf": 'module "pool_a" {\n  source = "../../modules/node-pool"\n  name   = "pool-a"\n}\n',
  "envs/production/main.tf": 'module "pool_a" {\n  source = "../../modules/node-pool"\n  name   = "pool-a"\n  size   = 6\n}\n',
};

const GENERIC: Seed = {
  "README.md": "# Project\n\nAttach notes about setup here.\n",
  "package.json": '{\n  "name": "project",\n  "private": true\n}\n',
  "src/index.ts": 'export function main() {\n  console.log("hello");\n}\n',
};

const SEEDS: Record<string, Seed> = {
  "atlas-api": ATLAS_API,
  "atlas-web": ATLAS_WEB,
  "orbit-app": ORBIT_APP,
  "docs-site": DOCS_SITE,
  "stress-kit": STRESS_KIT,
  ledger: LEDGER,
  infra: INFRA,
};

/** The in-memory tree for a folder label; unknown labels get a tiny generic project. */
export function seedFolder(label: string, mtime: string): Map<string, DemoFile> {
  const tree = new Map<string, DemoFile>();
  for (const [path, value] of Object.entries(SEEDS[label] ?? GENERIC)) {
    if (typeof value === "string") tree.set(path, { content: value, mtime });
    else if ("binary" in value) tree.set(path, { content: "", mtime, binary: true, size: 18_342 });
    else tree.set(path, { content: "", mtime, size: value.size });
  }
  return tree;
}
