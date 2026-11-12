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

export type ApprovalAction = "allow" | "allow_for_turn" | "allow_always" | "deny";

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

/** The resolved card's one line ("Allowed once", "Denied automatically after 30 minutes" …). */
export function resolutionLabel(r: Resolution): string {
  if (r.by === "timeout") return "Denied automatically";
  if (r.by === "cancelled") return "Denied: the turn was stopped";
  const verb =
    r.option ??
    (r.decision === "allow"
      ? "Allowed once"
      : r.decision === "allow_for_turn"
        ? "Allowed for this turn"
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
      return "Permission requested";
    case "network":
      return "Fetch a web page";
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
