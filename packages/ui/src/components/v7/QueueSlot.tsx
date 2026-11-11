import { useEffect, useState } from "react";
import type { QueueState } from "@octo/agent-client";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
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
  const { projectId } = useProject();
  const [queue, setQueue] = useState<QueueState>({ paused: false, messages: [] });
  useEffect(() => {
    let alive = true;
    void bridge.getQueue?.(projectId).then(
      (q) => alive && setQueue(q),
      // Not loaded: `queue.updated` events still arrive.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId]);
  useV7Events((e) => {
    if (e.type === "queue.updated") setQueue({ paused: e.paused, messages: e.messages });
  });
  const count = queue.messages.length;
  useEffect(() => onCount?.(count), [onCount, count]);

  return (
    <QueueList
      paused={queue.paused}
      messages={queue.messages}
      onRemove={(id) => bridge.removeQueued?.(projectId, id) ?? Promise.resolve()}
      onSendNow={(id) => bridge.sendQueuedNow?.(projectId, id) ?? Promise.resolve()}
      onResume={() => bridge.resumeQueue?.(projectId) ?? Promise.resolve()}
      onClear={() => bridge.clearQueue?.(projectId) ?? Promise.resolve()}
    />
  );
}
