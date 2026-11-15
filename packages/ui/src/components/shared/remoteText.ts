import type { RemoteDevice, RemoteStatus } from "@octo/agent-client";
import { timeAgo } from "../../lib/format";

/** The two sentences shown before remote access is turned on the first time (spec 2026-11-14 remote access, section 7). */
export const RISK_TEXT =
  "Anyone with access to a connected device can run agents on this computer. Only connect devices you own, and turn this off when you don't need it.";

/** The switch row's explanation line for a state. */
export function stateLine(s: RemoteStatus): string {
  switch (s.state) {
    case "off":
      return "Off. Your phone can reach this computer only while this is on.";
    case "starting":
      return "Opening a secure link through Cloudflare…";
    case "on": {
      const devices = s.online === 0 ? "no device connected" : s.online === 1 ? "1 device connected" : `${String(s.online)} devices connected`;
      const auto = s.idle_off_hours > 0 ? ` Turns off after ${hours(s.idle_off_hours)} without use, and when Octo quits.` : " Turns off when Octo quits.";
      return `On, ${devices}.${auto}`;
    }
    case "error":
      return s.error?.message ?? "Remote access stopped.";
  }
}

function hours(h: number): string {
  return h === 1 ? "an hour" : `${String(Math.round(h * 10) / 10)} hours`;
}

/** "4:59" until the code expires; "expired" after. */
export function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  if (left === 0) return "expired";
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, "0")}`;
}

/** One device's explanation line: when it paired and was last seen (what it may do is its "Read-only" switch, said once). */
export function deviceLine(d: RemoteDevice, now: number): string {
  if (d.status === "pending") return `Paired ${timeAgo(d.paired_at, now)}. Waiting for you to allow it.`;
  const seen = d.online ? "connected now" : d.last_seen ? `last seen ${timeAgo(d.last_seen, now)}` : "not used yet";
  return `Paired ${timeAgo(d.paired_at, now)} · ${seen}`;
}

/** The status bar's text while remote access is on (null when there is nothing to show). */
export function indicatorText(s: Pick<RemoteStatus, "state" | "online" | "pending">): string | null {
  if (s.state === "off") return null;
  if (s.state === "error") return "Remote access stopped";
  if (s.state === "starting") return "Remote…";
  if (s.pending > 0) return "Remote · allow?";
  return s.online > 0 ? `Remote · ${String(s.online)}` : "Remote";
}
