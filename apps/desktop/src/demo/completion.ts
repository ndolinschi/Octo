import { BridgeError, type AbortSignalLike, type Bridge, type CompletionRequest, type CompletionResult, type Project } from "@octo/agent-client";

/**
 * Demo inline completion (`?demo=1`): deterministic suggestions with 150–400 ms of latency, so ghost text can be
 * tried and screenshotted without a model. `?completion=off` leaves the projects without a completion model,
 * `budget` answers every request with 409 `budget_reached`, `fail` with a 502.
 */
export type DemoCompletionMode = "on" | "off" | "budget" | "fail";

export function completionMode(search: string): DemoCompletionMode {
  const v = new URLSearchParams(search).get("completion");
  return v === "off" || v === "budget" || v === "fail" ? v : "on";
}

const DEMO_MODEL = "claude-haiku-5-5";

/** Bodies the demo knows by function name (typed `function <name>(`, or a prefix of the name). */
const FUNCTIONS: Record<string, (indent: string) => string> = {
  revokeRefresh: (i) => `raw: string) {\n${i}  const token = await verifyRefresh(raw);\n${i}  await db.refreshTokens.revoke(token.id);\n${i}}`,
  rotateRefresh: (i) =>
    `raw: string) {\n${i}  const token = await verifyRefresh(raw);\n${i}  await db.refreshTokens.revoke(token.id);\n${i}  return issuePair(token.userId);\n${i}}`,
  clamp: (i) => `value: number, min: number, max: number): number {\n${i}  return Math.min(max, Math.max(min, value));\n${i}}`,
  sleep: (i) => `ms: number): Promise<void> {\n${i}  return new Promise((resolve) => setTimeout(resolve, ms));\n${i}}`,
  chunk: (i) =>
    `<T>(items: T[], size: number): T[][] {\n${i}  const out: T[][] = [];\n${i}  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));\n${i}  return out;\n${i}}`,
  unique: (i) => `<T>(items: T[]): T[] {\n${i}  return [...new Set(items)];\n${i}}`,
  capitalize: (i) => `text: string): string {\n${i}  return text.charAt(0).toUpperCase() + text.slice(1);\n${i}}`,
};

/** A few one-line endings by what the line ends with. */
const ENDINGS: [RegExp, string][] = [
  [/\breturn $/, "null;"],
  [/\bif \($/, '!token) throw new Error("refresh_invalid");'],
  [/\bawait $/, "db.refreshTokens.byRaw(raw);"],
  [/\bconsole\.$/, 'log("[atlas]", payload);'],
  [/^\s*\/\/ $/, "Tokens rotate on every use (docs/security.md)."],
  [/^\s*# $/, "Notes"],
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The demo's latency for a request: 150 to 400 ms, the same for the same text. */
export function demoLatency(prefix: string): number {
  return 150 + (hash(prefix) % 251);
}

/**
 * The deterministic suggestion for a cursor position, or null. Order: a known function body; the rest of an earlier
 * line that starts like the current one (code repeats itself); an ending for a few common line ends. Mid-line (text
 * after the cursor on its line) nothing is suggested.
 */
export function demoSuggest(prefix: string, suffix: string): string | null {
  const restOfLine = suffix.split("\n", 1)[0] ?? "";
  if (restOfLine.trim() !== "" && !/^[)\]};,]*$/.test(restOfLine.trim())) return null;
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const indent = /^\s*/.exec(line)?.[0] ?? "";

  const fn = /\bfunction\s+(\w*)(\(?)$/.exec(line);
  if (fn) {
    const typed = fn[1] ?? "";
    const name = Object.keys(FUNCTIONS).find((n) => typed.length >= 2 && n.startsWith(typed) && (n !== typed || fn[2] === "("));
    const body = name ? FUNCTIONS[name] : undefined;
    if (name && body) return (fn[2] === "(" ? "" : `${name.slice(typed.length)}(`) + body(indent);
  }

  const typed = line.trimStart();
  if (typed.length >= 3) {
    const lines = prefix
      .slice(0, prefix.length - line.length)
      .split("\n")
      .reverse();
    for (const earlier of lines) {
      const t = earlier.trimStart();
      if (t.length > typed.length && t.startsWith(typed)) return t.slice(typed.length);
    }
  }

  for (const [re, text] of ENDINGS) if (re.test(line)) return text;
  return null;
}

function wait(ms: number, signal: AbortSignalLike | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal instanceof AbortSignal) {
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("The request was aborted", "AbortError"));
      });
    }
  });
}

function withModel(project: Project): Project {
  return { ...project, models: { ...project.models, completion: project.models.completion ?? DEMO_MODEL } };
}

/** The demo bridge with `complete` and, unless `off`, a completion model on every project. */
export function withDemoCompletion(bridge: Bridge, mode: DemoCompletionMode): Bridge {
  if (mode === "off") return bridge;
  const complete = async (_projectId: string, input: CompletionRequest, options?: { signal?: AbortSignalLike }): Promise<CompletionResult | null> => {
    const ms = demoLatency(input.prefix);
    await wait(ms, options?.signal);
    if (mode === "budget") throw new BridgeError(409, "budget_reached", "the project's budget is reached");
    if (mode === "fail") throw new BridgeError(502, "completion_failed", "upstream timed out");
    const text = demoSuggest(input.prefix, input.suffix ?? "");
    return text === null ? null : { text, model: DEMO_MODEL, ms };
  };
  return {
    ...bridge,
    getProject: async (id) => withModel(await bridge.getProject(id)),
    updateProject: async (id, patch) => withModel(await bridge.updateProject(id, patch)),
    subscribe: (id, handlers) =>
      bridge.subscribe(id, {
        ...handlers,
        onEvent: (e) => handlers.onEvent(e.type === "project.updated" ? { ...e, project: withModel(e.project) } : e),
      }),
    complete,
  };
}
