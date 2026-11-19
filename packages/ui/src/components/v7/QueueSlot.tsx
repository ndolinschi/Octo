import { useEffect, useState } from "react";
import type { QueueState } from "@octo/agent-client";
import { steerUnsupportedFor } from "../../lib/v7/steerQueue";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { QueueList } from "./QueueList";
import { useV7Events } from "./useV7Events";

export type QueueSlotProps = {
  /** The number waiting, for the badge on the send button (`QueueBadge`). */
  onCount?(count: number): void;
};

/**
 * Composer slot (v7 §2): the messages waiting for the running turn, loaded from `getQueue` and kept current by
 * `queue.updated`. Renders nothing when the bridge lacks the queue methods or the queue is empty and running.
 * Mount directly above the composer.
 */
export function QueueSlot(props: QueueSlotProps) {
  const { bridge } = useApp();
  if (!bridge.getQueue || !bridge.removeQueued || !bridge.sendQueuedNow || !bridge.resumeQueue || !bridge.clearQueue) return null;
  return <Live {...props} />;
}

function Live({ onCount }: QueueSlotProps) {
  const { bridge } = useApp();
  const { projectId, project, synced, state, kept } = useProject();
  // Decision 98: the queue as last read (this project shown before) paints with the conversation; the read updates it.
  const key = useSessionScope()?.sessionId ?? "";
  const [queue, setQueue] = useState<QueueState>(() => kept.queues.get(key) ?? { paused: false, messages: [] });
  useEffect(() => {
    let alive = true;
    void bridge.getQueue?.(projectId).then(
      (q) => {
        kept.queues.set(key, q);
        if (alive) setQueue(q);
      },
      // Not loaded: `queue.updated` events still arrive.
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // `synced`: loaded again after a reconnect (a `queue.updated` may have been missed).
  }, [bridge, projectId, synced, kept, key]);
  useV7Events((e) => {
    if (e.type !== "queue.updated") return;
    const q = { paused: e.paused, messages: e.messages };
    kept.queues.set(key, q);
    setQueue(q);
  });
  const count = queue.messages.length;
  // Decision 96: a message waiting for a slot says so, with how many of the project's sessions run now.
  const running = Object.values(state.agents).filter((a) => a.parent_id === null && a.status === "running").length;
  const waiting = queue.messages.some((m) => m.waiting_for === "slot")
    ? `Waiting for a free slot (${running} ${running === 1 ? "session" : "sessions"} running)`
    : null;
  useEffect(() => onCount?.(count), [onCount, count]);

  return (
    <QueueList
      paused={queue.paused}
      waiting={waiting}
      messages={queue.messages}
      onRemove={(id) => bridge.removeQueued?.(projectId, id) ?? Promise.resolve()}
      onSendNow={async (id) => void (await bridge.steerQueued?.(projectId, id))}
      onStopAndSend={(id) => bridge.sendQueuedNow?.(projectId, id, { interrupt: true }) ?? Promise.resolve()}
      steerUnsupported={steerUnsupportedFor(project?.models.orchestrator) || !bridge.steerQueued}
      onResume={() => bridge.resumeQueue?.(projectId) ?? Promise.resolve()}
      onClear={() => bridge.clearQueue?.(projectId) ?? Promise.resolve()}
    />
  );
}
