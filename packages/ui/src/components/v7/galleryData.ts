import {
  BridgeError,
  type Approval,
  type ChangeDetail,
  type FileChange,
  type InputRequest,
  type QueuedMessage,
  type RevertResult,
  type TurnChanges,
} from "@octo/agent-client";
import type { ChangesApi } from "./useChanges";

/** Fixtures of the v7 gallery (`#/__v7`, demo only): every card in every state, and a scripted changes API. */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export const APPROVALS: Record<"command" | "write" | "acp" | "urgent", Approval> = {
  command: {
    id: "apr_cmd",
    agent_id: "agt_1",
    agent_label: "coder",
    turn_id: 12,
    kind: "command",
    title: "pnpm --filter @octo/ui test",
    detail: { command: "pnpm --filter @octo/ui test && git commit -am 'Fold unchanged regions in the diff'" },
    created_at: ago(2 * MIN + 14_000),
  },
  write: {
    id: "apr_write",
    agent_id: "agt_2",
    agent_label: "reviewer",
    turn_id: 12,
    kind: "write",
    title: "Write packages/ui/src/lib/format.ts",
    detail: { folder: "octo", path: "packages/ui/src/lib/format.ts", diff: { added: 14, removed: 3 } },
    created_at: ago(9 * MIN),
  },
  acp: {
    id: "apr_acp",
    agent_id: "agt_3",
    agent_label: "claude-code",
    turn_id: 12,
    kind: "acp",
    title: "Run the database migration and restart the dev server",
    detail: {
      command: "go run ./cmd/harness migrate --data-dir ./data && pnpm dev:all",
      options: [
        { id: "allow-once", label: "Allow once", kind: "allow_once" },
        { id: "allow-always", label: "Always allow", kind: "allow_always" },
        { id: "reject", label: "Reject", kind: "reject_once" },
      ],
    },
    created_at: ago(5 * MIN),
  },
  urgent: {
    id: "apr_urgent",
    agent_id: "agt_1",
    agent_label: "coder",
    turn_id: 12,
    kind: "command",
    title: "rm -rf node_modules",
    detail: { command: "rm -rf node_modules && pnpm install" },
    created_at: ago(29 * MIN + 20_000),
  },
};

export const FORMS: Record<"full" | "secret", InputRequest> = {
  full: {
    id: "inp_full",
    agent_id: "agt_1",
    agent_label: "coder",
    turn_id: 12,
    title: "Deploy settings",
    reason: "I need these before I can write the deploy script. The token goes straight to the harness and is never shown to the model.",
    fields: [
      { id: "name", label: "Service name", kind: "text", required: true, help: "Lowercase, used in the hostname." },
      { id: "token", label: "Deploy token", kind: "secret", required: true },
      { id: "region", label: "Region", kind: "select", options: ["eu-west", "us-east", "ap-south"], required: true },
      { id: "env", label: "Environment", kind: "select", options: ["development", "staging", "production", "preview", "canary", "sandbox"] },
      { id: "dir", label: "Output folder", kind: "path" },
      { id: "yes", label: "Run the smoke tests after deploying", kind: "confirm" },
    ],
    created_at: ago(MIN),
  },
  secret: {
    id: "inp_secret",
    agent_id: "agt_1",
    agent_label: "coder",
    turn_id: 12,
    title: "API key",
    reason: "",
    fields: [{ id: "api_key", label: "API key", kind: "secret", required: true }],
    created_at: ago(MIN),
  },
};

export const QUEUE: QueuedMessage[] = [
  "Then rename the helper to formatBytes and update its callers",
  "Add a test for the empty case",
  "After that, run the full lint and paste the summary of warnings by file so that I can decide which to fix first",
  "Open a PR with a short description",
  "Update the changelog",
].map((text, i) => ({ id: `q${i + 1}`, text, created_at: ago((5 - i) * MIN) }));

const BEFORE = `import { clsx } from "clsx";

export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function plural(n: number, one: string, many = one + "s"): string {
  return n === 1 ? one : many;
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export const cn = clsx;
`;

const AFTER = BEFORE.replace(
  `export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}`,
  `const UNITS = ["B", "KB", "MB", "GB"] as const;

/** 1536 -> "1.5 KB"; negative and non-finite sizes read as "0 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return \`\${i === 0 ? value : value.toFixed(1)} \${UNITS[i]}\`;
}`,
).replace(`return i < 0 ? path : path.slice(i + 1);`, `return i < 0 ? path : path.slice(i + 1) || path;`);

const NEW_FILE = `import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("reads zero and negative sizes as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
  it("picks the unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
`;

const change = (
  id: number,
  turn: number,
  path: string,
  kind: FileChange["kind"],
  added: number | null,
  removed: number | null,
  extra: Partial<FileChange> = {},
): FileChange => ({
  id,
  turn_id: turn,
  agent_id: "agt_1",
  folder: "octo",
  path,
  kind,
  added,
  removed,
  created_at: ago((20 - id) * MIN),
  note: "",
  source: "write_file",
  ...extra,
});

const FILES: FileChange[] = [
  change(1, 12, "packages/ui/src/lib/format.ts", "modified", 11, 5),
  change(2, 12, "packages/ui/src/lib/format.test.ts", "created", 12, 0),
  change(3, 12, "packages/ui/src/lib/legacy.ts", "deleted", 0, 24),
  change(4, 12, "dist/app.wasm", "modified", null, null, { note: "binary", source: "bash" }),
  change(5, 12, "docs/notes.md", "modified", null, null, { note: "no_preimage", source: "acp_turn" }),
  change(6, 9, "apps/desktop/src/main.tsx", "modified", 2, 1),
];

const summary = (c: FileChange) => {
  const { id, agent_id, ...rest } = c;
  return { ...rest, change_ids: [id], agent_ids: [agent_id] };
};

export const TURNS: TurnChanges[] = [
  { turn_id: 12, files: FILES.filter((f) => f.turn_id === 12).map(summary), added: 23, removed: 32 },
  { turn_id: 9, files: FILES.filter((f) => f.turn_id === 9).map(summary), added: 2, removed: 1 },
];

export const TURN_LABELS: Record<number, string> = { 12: "Make formatBytes handle zero and negative sizes", 9: "Mount the app" };

function detail(id: number): ChangeDetail {
  const c = FILES.find((f) => f.id === id);
  if (!c) throw new BridgeError(404, "not_found", "no such change");
  const none = c.note === "binary" || c.note === "no_preimage";
  const texts: Record<number, [string | null, string | null]> = {
    1: [BEFORE, AFTER],
    2: [null, NEW_FILE],
    3: [BEFORE.split("\n").slice(0, 24).join("\n"), null],
    6: ["createRoot(el).render(<App />);\n", "createRoot(el).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n"],
  };
  const [before, after] = texts[id] ?? [null, null];
  return { ...c, before: none ? null : before, after: none ? null : after, diff_available: !none };
}

/** How the scripted API answers `revertChange`: it works, or fails the way the harness does. */
export type RevertMode = "ok" | "file_changed" | "revert_unavailable" | "slow";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function changesApi(mode: "ready" | "empty" | "loading" | "error", revert: RevertMode = "ok"): ChangesApi {
  return {
    listChanges: async () => {
      if (mode === "loading") return new Promise<TurnChanges[]>(() => undefined);
      if (mode === "error") throw new Error("The harness did not answer");
      await wait(80);
      return mode === "empty" ? [] : TURNS;
    },
    getChange: async (id) => {
      await wait(60);
      return detail(id);
    },
    revertChange: async (id): Promise<RevertResult> => {
      await wait(revert === "slow" ? 2500 : 250);
      if (revert === "file_changed") throw new BridgeError(409, "file_changed", "the file changed");
      if (revert === "revert_unavailable") throw new BridgeError(409, "revert_unavailable", "no original");
      const c = detail(id);
      return { folder: c.folder, path: c.path, size: 0, mtime: new Date().toISOString() };
    },
  };
}
