import type { GlobalSession } from "@octo/agent-client";
import { useSyncExternalStore } from "react";
import { choiceCodec, loadPref, PREFS, writePref } from "./storage";

/** Parity B8 / Claude Code Desktop: opt-in desktop notifications when background sessions finish, fail, or need input. */
export const notificationsCodec = choiceCodec(["on", "off"] as const, "off");
export type NotificationsPref = "on" | "off";

export type NotificationKind = "finished" | "failed" | "needs";

export type SessionNotification = {
  id: string;
  projectId: string;
  sessionId: string;
  kind: NotificationKind;
  title: string;
  body: string;
};

export type SessionSnapshot = Pick<GlobalSession, "id" | "project_id" | "project_name" | "title" | "state" | "needs_you">;

/**
 * Compares previous and current session snapshots and returns notifications for newly settled or blocked sessions:
 * - working/queued -> waiting or needs_you: needs your input
 * - any non-failed -> failed: failed
 * - working/waiting -> idle (not needs_you): finished
 */
export function detectNotificationEvents(prev: ReadonlyMap<string, SessionSnapshot>, next: readonly SessionSnapshot[]): SessionNotification[] {
  const out: SessionNotification[] = [];
  for (const s of next) {
    const before = prev.get(s.id);
    if (!before) continue;
    const label = s.title.trim() || s.project_name;
    const wasNeeds = before.state === "waiting" || before.needs_you === true;
    const isNeeds = s.state === "waiting" || s.needs_you === true;
    if (!wasNeeds && isNeeds) {
      out.push({
        id: `${s.id}:needs`,
        projectId: s.project_id,
        sessionId: s.id,
        kind: "needs",
        title: `${s.project_name} needs your input`,
        body: label === s.project_name ? "Waiting for your approval or response." : label,
      });
      continue;
    }
    if (before.state !== "failed" && s.state === "failed") {
      out.push({
        id: `${s.id}:failed`,
        projectId: s.project_id,
        sessionId: s.id,
        kind: "failed",
        title: `${s.project_name} failed`,
        body: label === s.project_name ? "A session ended with an error." : label,
      });
      continue;
    }
    if ((before.state === "working" || before.state === "waiting") && s.state === "idle" && !isNeeds) {
      out.push({
        id: `${s.id}:finished`,
        projectId: s.project_id,
        sessionId: s.id,
        kind: "finished",
        title: `${s.project_name} finished`,
        body: label === s.project_name ? "Your session is ready." : label,
      });
    }
  }
  return out;
}

export function notificationSupport(): "supported" | "denied" | "unsupported" {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "supported";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function fireDesktopNotification(event: SessionNotification, onClick: () => void): void {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof Notification === "undefined") return;
  if (!document.hidden || Notification.permission !== "granted") return;
  try {
    const n = new Notification(event.title, { body: event.body, tag: event.id });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Ignore host webviews that block Notification construction.
  }
}

let cached: NotificationsPref | null = null;
const listeners = new Set<() => void>();

export function getNotificationsPref(): NotificationsPref {
  cached ??= loadPref(PREFS.notifications, notificationsCodec);
  return cached;
}

export function setNotificationsPref(next: NotificationsPref): void {
  if (cached === next) return;
  cached = next;
  writePref(PREFS.notifications, notificationsCodec.stringify(next));
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useNotificationsPref(): NotificationsPref {
  return useSyncExternalStore(subscribe, getNotificationsPref, () => "off");
}
