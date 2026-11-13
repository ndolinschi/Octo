import type { RewindConflict, RewindReport } from "@octo/agent-client";

/** Parity B5: what the rewind dialog says about a report, in plain sentences. */

export const CONFLICT_REASON: Record<RewindConflict["reason"], string> = {
  modified_outside: "changed outside Octo since the agent's last edit",
  unavailable: "its earlier content was not kept",
  folder_missing: "its folder is gone",
};

export function conflictReason(reason: string): string {
  return reason in CONFLICT_REASON ? CONFLICT_REASON[reason as RewindConflict["reason"]] : reason;
}

/** "Restores 2 files and deletes 1" / "No file changes to undo". */
export function filesSummary(report: Pick<RewindReport, "files">): string {
  const restore = report.files.filter((f) => f.action === "restore").length;
  const del = report.files.filter((f) => f.action === "delete").length;
  const plural = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  if (restore === 0 && del === 0) return "No file changes to undo.";
  const parts = [restore ? `restores ${plural(restore)}` : "", del ? `deletes ${plural(del)}` : ""].filter(Boolean);
  const text = parts.join(" and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** "Removes this request and 13 later messages." */
export function cutSummary(report: Pick<RewindReport, "messages_cut" | "agents_cut">): string {
  const later = Math.max(0, report.messages_cut - 1);
  const messages = later === 0 ? "Removes this request." : `Removes this request and ${later} later ${later === 1 ? "message" : "messages"}`;
  const agents = report.agents_cut > 0 ? ` and hides ${report.agents_cut} ${report.agents_cut === 1 ? "sub-agent" : "sub-agents"}` : "";
  return `${messages.replace(/\.$/, "")}${agents}.`;
}

export const ACP_RESET_NOTE = "The agent's own session was reset. Its next turn starts a new session with a recap of what is left.";

/** Rewinding is refused with these codes; each reads as one sentence with a next step. */
export function rewindError(code: string | null): string | null {
  if (code === "turn_in_progress") return "A turn is running. Stop it or wait for it to finish, then rewind.";
  if (code === "invalid_request") return "That request is no longer in the conversation. Close this and try another one.";
  return null;
}
