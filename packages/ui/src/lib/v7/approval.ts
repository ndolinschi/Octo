import type { Approval, ApprovalAnswer, ApprovalDecision, ApprovalOption } from "@octo/agent-client";

/**
 * Approval cards (v7 §3, apps/harness/docs/v7.md §2): countdown to the unattended deny, keys, answers, the one-line
 * resolved summary and the list the transcript shows (pending from the bridge plus what was resolved this session).
 */

/** The harness denies an unanswered request after `HARNESS_APPROVAL_TIMEOUT` (default 30m). The UI cannot read it. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
/** Below this the countdown turns `warn`. */
export const APPROVAL_URGENT_MS = 60_000;

/** When the request will be denied by the harness; null when it waits for ever (timeout ≤ 0) or the date is unreadable. */
export function approvalDeadline(createdAt: string, timeoutMs: number = APPROVAL_TIMEOUT_MS): number | null {
  const t = Date.parse(createdAt);
  if (timeoutMs <= 0 || Number.isNaN(t)) return null;
  return t + timeoutMs;
}

/** "29:41", "0:09", "1:02:03" — whole seconds, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export type ApprovalAction = "allow" | "allow_for_turn" | "allow_all_for_turn" | "allow_always" | "deny";

/** Card keys: `A` allows once, `D` denies, `Enter` on the card allows. Modified keys and typing in a field are not ours. */
export function keyAction(key: string, mods: { ctrl: boolean; meta: boolean; alt: boolean }, inField: boolean): ApprovalAction | null {
  if (inField || mods.ctrl || mods.meta || mods.alt) return null;
  if (key === "a" || key === "A" || key === "Enter") return "allow";
  if (key === "d" || key === "D") return "deny";
  return null;
}

/** The body of POST .../approvals/{id}: a note only with a denial, and only when it says something. */
export function answerFor(action: ApprovalAction, note = ""): ApprovalAnswer {
  const text = note.trim();
  return action === "deny" && text ? { decision: "deny", note: text } : { decision: action };
}

/** An ACP agent's own option: allow options allow (the harness passes the option id on), reject options deny. */
export function optionAnswer(option: ApprovalOption, note = ""): ApprovalAnswer {
  const allow = option.kind === "allow_once" || option.kind === "allow_always";
  const text = note.trim();
  if (allow) return { decision: "allow", option_id: option.id };
  return text ? { decision: "deny", option_id: option.id, note: text } : { decision: "deny", option_id: option.id };
}

export function isAllowOption(option: ApprovalOption): boolean {
  return option.kind === "allow_once" || option.kind === "allow_always";
}

/** Why a card closed: the user here, the harness's timer, a cancelled turn, or someone else (another window). */
export type ResolvedBy = "you" | "timeout" | "cancelled" | "elsewhere";
/** `rule`: the code of the rule an "always allow" saved (parity B4), shown in the resolved line. */
export type Resolution = { decision: ApprovalDecision; by: ResolvedBy; note?: string; option?: string; rule?: string };

/** True for a POSIX shell variable name (`[A-Za-z_][A-Za-z0-9_]*`), mirroring harness `approval.isName`. */
function isShellName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Splits a shell command into words only when it is a single simple command, mirroring `apps/harness/internal/approval`
 * `Tokens` (`rules.go`). Returns null for separators (`&& || ; | &`, newlines), redirections (`< >`), subshells or
 * substitutions (`( )`, `$(...)`, backticks), expansions (`$VAR`), comments (`#`), leading `VAR=val` assignments,
 * unterminated quotes, or empty input — so a turn grant is never offered for a compound command even without `no_turn_grant`.
 */
function simpleCommandTokens(command: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let have = false;
  const flush = () => {
    if (!have) return;
    words.push(cur);
    cur = "";
    have = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      have = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const ch = command[j];
        if (ch === "$" || ch === "`") return null;
        if (ch === "\\") {
          const next = command[j + 1];
          if (next !== undefined && '"\\$`\n'.includes(next)) {
            if (next === "\n" || next === "$" || next === "`") return null;
            j++;
            cur += next;
            continue;
          }
        }
        cur += ch ?? "";
      }
      if (j >= command.length) return null;
      have = true;
      i = j;
    } else if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n") return null;
      i++;
      cur += next;
      have = true;
    } else if (c === " " || c === "\t") {
      flush();
    } else if (";&|<>()`$\n\r".includes(c)) {
      return null;
    } else if (c === "#" && !have) {
      return null;
    } else {
      cur += c;
      have = true;
    }
  }
  flush();
  const first = words[0];
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq > 0 && isShellName(first.slice(0, eq))) return null;
  return words;
}

/** The program "allow for this request" remembers for a simple command: its first word's basename (harness `CommandGrantKey`). */
function simpleCommandProgram(command: string): string | null {
  const words = simpleCommandTokens(command);
  const first = words?.[0];
  if (!first) return null;
  const normalized = first.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base || null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return ""; // not a URL: the label says "fetches" without a host
  }
}

/** ACP tool kinds (ACP `ToolKind`) as the plural the label uses; the harness remembers `allow_for_turn` per tool kind. */
const ACP_KIND_NOUNS: Readonly<Record<string, string>> = {
  edit: "edits",
  delete: "deletions",
  move: "moves",
  execute: "commands",
  fetch: "fetches",
  think: "thinking steps",
};

/**
 * What "Allow … for this request" (`allow_for_turn`) covers for the rest of the turn, as the harness remembers it
 * (apps/harness/docs/v7.md): this agent's edits, its commands of the same program, its fetches from the same host, or
 * its ACP tool calls of the same kind. Null for a memory prompt and for a compound command (`no_turn_grant`), which
 * nothing remembers: the card offers only "Allow once" there.
 */
export function turnScopeLabel(a: Approval): string | null {
  if (a.no_turn_grant) return null;
  switch (a.kind) {
    case "write":
      return "edits";
    case "command": {
      const program = simpleCommandProgram(a.detail.command ?? "");
      return program ? `${program} commands` : null;
    }
    case "network": {
      const host = hostOf(a.detail.url ?? "");
      return host ? `fetches from ${host}` : "fetches";
    }
    case "acp": {
      const kind = a.tool?.startsWith("acp:") ? a.tool.slice(4) : "";
      return ACP_KIND_NOUNS[kind] ?? (kind && kind !== "other" ? `${kind} actions` : "other actions");
    }
    case "memory":
      return null;
  }
}

/** The resolved card's one line ("Allowed once", "Allowed edits for this request", "Denied automatically" …). */
export function resolutionLabel(r: Resolution, a?: Approval): string {
  if (r.by === "timeout") return "Denied automatically";
  if (r.by === "cancelled") return "Denied: stopped";
  const scope = a ? turnScopeLabel(a) : null;
  const verb =
    r.option ??
    (r.decision === "allow"
      ? "Allowed once"
      : r.decision === "allow_for_turn"
        ? scope
          ? `Allowed ${scope} for this request`
          : "Allowed for this request"
        : r.decision === "allow_all_for_turn"
          ? "Allowed all for this request"
          : r.decision === "allow_always"
            ? "Always allowed"
            : "Denied");
  return r.by === "elsewhere" ? `${verb} elsewhere` : verb;
}

/**
 * Who resolved a request the client saw disappear: our own answer wins; a deny at or after the deadline is the timer;
 * a deny while the turn was being stopped is the cancel; anything else came from another client.
 */
export function resolutionCause(
  decision: ApprovalDecision,
  ctx: { local: Resolution | undefined; now: number; deadline: number | null; turnStopped: boolean },
): Resolution {
  if (ctx.local) return ctx.local;
  if (decision === "deny" && ctx.deadline !== null && ctx.now >= ctx.deadline - 1000) return { decision, by: "timeout" };
  if (decision === "deny" && ctx.turnStopped) return { decision, by: "cancelled" };
  return { decision, by: "elsewhere" };
}

export type ApprovalItem = { approval: Approval; resolution: Resolution | null };

/**
 * What the transcript lists: every request seen this session, oldest first — pending ones from the live list (events or
 * a reload), resolved ones kept with their resolution so they collapse to one line instead of vanishing.
 */
export function approvalItems(pending: readonly Approval[], seen: readonly Approval[], resolved: Readonly<Record<string, Resolution>>): ApprovalItem[] {
  const byId = new Map<string, Approval>();
  for (const a of seen) byId.set(a.id, a);
  for (const a of pending) byId.set(a.id, a);
  const live = new Set(pending.map((a) => a.id));
  const items: ApprovalItem[] = [];
  for (const a of byId.values()) {
    const r = resolved[a.id];
    if (live.has(a.id) && !r) items.push({ approval: a, resolution: null });
    else if (r) items.push({ approval: a, resolution: r });
  }
  return items.sort((x, y) => x.approval.created_at.localeCompare(y.approval.created_at));
}

/** "Write" / "Run" / the ACP title's verb is the card's caption; the subject is the path or command. */
export function approvalCaption(a: Approval): string {
  switch (a.kind) {
    case "write":
      return "Edit a file";
    case "command":
      return "Run a command";
    case "acp":
      return "Needs your permission";
    case "network":
      return "Fetch a web page";
    case "memory":
      return a.title || "Enable auto memory?";
  }
}

/** Two to five blocks showing the share of added and removed lines (a diffstat bar), never all empty for a change. */
export function diffBlocks(added: number, removed: number, blocks = 5): ("add" | "del" | "none")[] {
  const total = added + removed;
  if (total <= 0) return Array.from({ length: blocks }, () => "none" as const);
  const filled = Math.min(blocks, Math.max(added > 0 && removed > 0 ? 2 : 1, Math.ceil((total / Math.max(total, 20)) * blocks)));
  let add = Math.round((added / total) * filled);
  if (added > 0 && add === 0) add = 1;
  if (removed > 0 && add === filled) add = filled - 1;
  const out: ("add" | "del" | "none")[] = [];
  for (let i = 0; i < blocks; i++) out.push(i < add ? "add" : i < filled ? "del" : "none");
  return out;
}

/**
 * True when an event starts a new user turn on the orchestrator or resets the conversation, meaning
 * already-resolved approvals and closed/answered forms from earlier turns should be cleared from the bottom slot.
 */
export function shouldPruneCompleted(event: { type: string; message?: { role: string; agent_id?: string } }, orchestratorId: string | undefined): boolean {
  if (event.type === "conversation.rewound" || event.type === "conversation.cleared") return true;
  return event.type === "message.created" && event.message?.role === "user" && (!orchestratorId || event.message.agent_id === orchestratorId);
}

/** Drops items whose ids appear in `done`, keeping still-pending items in order. */
export function pruneCompleted<T extends { id: string }>(seen: readonly T[], done: Readonly<Record<string, unknown>>): T[] {
  return seen.filter((item) => done[item.id] === undefined);
}
