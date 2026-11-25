import { useEffect, useRef } from "react";
import { detectNotificationEvents, fireDesktopNotification, useNotificationsPref, type SessionSnapshot } from "../../lib/notifications";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import { useSessionIndex } from "../../state/sessionIndex";

/**
 * Parity B8 / Claude Code Desktop: watches session transitions across all projects and fires native desktop notifications
 * when a session finishes, fails, or needs input while the window is hidden/unfocused.
 * Mounted lazily by AppShell so it costs nothing in the initial entry bundle.
 */
export default function DesktopNotifier() {
  const pref = useNotificationsPref();
  const { projects } = useApp();
  const enabled = pref === "on";
  const index = useSessionIndex(enabled ? projects : null);
  const prevRef = useRef<Map<string, SessionSnapshot> | null>(null);

  useEffect(() => {
    if (!enabled) {
      prevRef.current = null;
      return;
    }
    if (!index.loaded) return;
    const prev = prevRef.current;
    const next = new Map<string, SessionSnapshot>();
    for (const s of index.all) next.set(s.id, s);
    prevRef.current = next;
    if (!prev) return;
    for (const ev of detectNotificationEvents(prev, index.all)) {
      fireDesktopNotification(ev, () => navigate(ev.projectId, null, ev.sessionId));
    }
  }, [enabled, index.loaded, index.all]);

  return null;
}
