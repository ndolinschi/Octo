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

/**
 * "Removes the next request and 13 later messages." R2 (checkpoints): "Restore to here" under a reply restores to the end of
 * that reply, which cuts the request after it (`next`); `/rewind` cuts the newest request itself (`this`).
 */
export function cutSummary(report: Pick<RewindReport, "messages_cut" | "agents_cut">, which: "next" | "this" = "next"): string {
  const later = Math.max(0, report.messages_cut - 1);
  const request = which === "next" ? "the next request" : "your last request";
  const messages = later === 0 ? `Removes ${request}.` : `Removes ${request} and ${later} later ${later === 1 ? "message" : "messages"}`;
  const agents = report.agents_cut > 0 ? ` and hides ${report.agents_cut} ${report.agents_cut === 1 ? "agent" : "agents"}` : "";
  return `${messages.replace(/\.$/, "")}${agents}.`;
}

export const ACP_RESET_NOTE = "The agent starts over from a recap of what is left.";

/** The action's one name in the app (R2, checkpoints); the slash command keeps its name, `/rewind`. */
export const RESTORE_LABEL = "Restore to here";

/** The accessible name of a reply's restore action: the action, then the start of the reply's request. */
export function restoreName(request: string): string {
  const line =
    request
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const short = line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
  return short ? `${RESTORE_LABEL}: ${short}` : RESTORE_LABEL;
}

/** Restoring is refused with these codes; each reads as one sentence with a next step. */
export function rewindError(code: string | null): string | null {
  if (code === "turn_in_progress") return "Octo is still working. Stop it or wait, then restore.";
  if (code === "invalid_request") return "That request is no longer in the session. Close this and try another one.";
  return null;
}
