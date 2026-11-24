/**
 * Lightweight per-project store of reviewed/kept file change keys (`rowKey(turnId, file)`).
 * Shared between the sticky review bar above the composer (`chat/PendingChangesBar`) and the
 * Changes tab (`v7/ChangesView`) without features importing each other.
 */
const EMPTY: ReadonlySet<string> = new Set();
const byProject = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

export function subscribeKeptChanges(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function keptChangesSnapshot(projectId: string): ReadonlySet<string> {
  return byProject.get(projectId) ?? EMPTY;
}

export function toggleFileKept(projectId: string, key: string): boolean {
  const prev = byProject.get(projectId);
  const next = new Set(prev ?? []);
  const kept = !next.has(key);
  if (kept) next.add(key);
  else next.delete(key);
  byProject.set(projectId, next);
  emit();
  return kept;
}

export function keepAllFiles(projectId: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const prev = byProject.get(projectId);
  const next = new Set(prev ?? []);
  let changed = false;
  for (const k of keys) {
    if (!next.has(k)) {
      next.add(k);
      changed = true;
    }
  }
  if (!changed) return;
  byProject.set(projectId, next);
  emit();
}

export function clearKeptChanges(projectId: string): void {
  if (byProject.delete(projectId)) emit();
}
