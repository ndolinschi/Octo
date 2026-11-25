/**
 * Lightweight handoff for `/btw <question>` from the main composer to `SidePanel`:
 * queues the question for `projectId` and wakes any mounted `SidePanel` to send it immediately.
 */
let queued: { projectId: string; text: string } | null = null;
const listeners = new Set<() => void>();

export function queueSideQuestion(projectId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  queued = { projectId, text: trimmed };
  for (const l of listeners) l();
}

export function takeSideQuestion(projectId: string): string | null {
  if (queued?.projectId !== projectId) return null;
  const text = queued.text;
  queued = null;
  return text;
}

export function onSideQuestion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
