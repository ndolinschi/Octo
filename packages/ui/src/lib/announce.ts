import { formatDuration } from "./format";

export type EndStatus = "completed" | "failed" | "cancelled";

/**
 * 7b: what the conversation's polite live region says when a request ends: "Finished: Worked for 8s", "Failed after 8s",
 * "Stopped after 8s" (the turn head's words); without a duration, the ending alone. The reply's text is never read out.
 */
export function endAnnouncement(status: EndStatus, ms: number | null): string {
  const time = ms !== null && ms >= 1000 ? formatDuration(ms) : null;
  if (status === "cancelled") return time ? `Stopped after ${time}` : "Stopped";
  if (status === "failed") return time ? `Failed after ${time}` : "Failed";
  return time ? `Finished: Worked for ${time}` : "Finished";
}

/** 7b: an approval or a form that appeared: "Atlas API asks: Run npm test". */
export function askAnnouncement(project: string, title: string): string {
  const what = title.replace(/\s+/g, " ").trim();
  return what ? `${project} asks: ${what}` : `${project} is waiting for you`;
}

/** The ids in `now` that `seen` does not have, in order (new approvals and forms since the last look). */
export function newIds(seen: ReadonlySet<string>, now: readonly { id: string }[]): string[] {
  return now.filter((x) => !seen.has(x.id)).map((x) => x.id);
}
