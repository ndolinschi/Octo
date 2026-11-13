import type { MemoryFile, MemorySession, MemorySessionDetail, Task } from "@octo/agent-client";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { isNotFound, type Load } from "../../lib/memory/load";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

type Settled<T> = { key: string; load: Load<T> | { status: "none" } };

/**
 * One read keyed by `key`: loading until the first answer for that key, then the answer. A re-read with the same key
 * (`tick` moved on) keeps showing the old value, and a failed re-read keeps it too. State is set only from the
 * promise, never in the effect body.
 */
function useRead<T>(key: string, read: (() => Promise<T>) | null, tick: number, none?: (e: unknown) => boolean): Load<T> | { status: "none" } {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const latest = read;
  useEffect(() => {
    if (!latest) return;
    let cancelled = false;
    latest().then(
      (value) => !cancelled && setSettled({ key, load: { status: "ok", value } }),
      (e: unknown) => {
        if (cancelled) return;
        if (none?.(e)) setSettled({ key, load: { status: "none" } });
        else setSettled((prev) => (prev?.key === key && prev.load.status === "ok" ? prev : { key, load: { status: "error", message: errorMessage(e) } }));
      },
    );
    return () => {
      cancelled = true;
    };
    // `read` is rebuilt every render; `key` and `tick` say when it means something else.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [key, tick]);
  return settled?.key === key ? settled.load : { status: "loading" };
}

/** Task records of a project, re-read when the harness reports a change (`task.updated`). */
export function useTasks(projectId: string): { load: Load<Task[]>; reload(): void } {
  const { bridge } = useApp();
  const { onEvent } = useProject();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => onEvent((e) => e.type === "task.updated" && setTick((t) => t + 1)), [onEvent]);
  const list = bridge.listTasks;
  const load = useRead(`tasks|${projectId}`, list ? () => list.call(bridge, projectId) : null, tick);
  return { load: load.status === "none" ? { status: "loading" } : load, reload };
}

/** Memory files (without content), re-read after `memory.updated`. */
export function useMemoryFiles(projectId: string): { load: Load<MemoryFile[]>; reload(): void } {
  const { bridge } = useApp();
  const { onEvent } = useProject();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => onEvent((e) => e.type === "memory.updated" && setTick((t) => t + 1)), [onEvent]);
  const list = bridge.listMemory;
  const load = useRead(`files|${projectId}`, list ? async () => (await list.call(bridge, projectId)).files : null, tick);
  return { load: load.status === "none" ? { status: "loading" } : load, reload };
}

/** One file with its content; `revision` moves on after a save so the content is read again. */
export function useMemoryFile(projectId: string, path: string, revision: number): Load<MemoryFile> {
  const { bridge } = useApp();
  const get = bridge.getMemoryFile;
  const load = useRead(`file|${projectId}|${path}`, get ? () => get.call(bridge, projectId, path) : null, revision);
  return load.status === "none" ? { status: "loading" } : load;
}

/** Sessions, newest first (the latest 50), re-read after `memory.updated` (an exchange recorded or forgotten, a session ended). */
export function useSessions(projectId: string): { load: Load<MemorySession[]>; reload(): void; tick: number } {
  const { bridge } = useApp();
  const { onEvent } = useProject();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => onEvent((e) => e.type === "memory.updated" && setTick((t) => t + 1)), [onEvent]);
  const list = bridge.listMemorySessions;
  const load = useRead(`sessions|${projectId}`, list ? () => list.call(bridge, projectId, { limit: SESSION_PAGE }) : null, tick);
  return { load: load.status === "none" ? { status: "loading" } : load, reload, tick };
}

/** The most sessions the list asks for; older ones are not paged in this view. */
const SESSION_PAGE = 50;

/** One session with its exchanges; `tick` moves on when the list was re-read, so a new exchange shows up. */
export function useSession(projectId: string, sessionId: string, tick: number): Load<MemorySessionDetail> {
  const { bridge } = useApp();
  const get = bridge.getMemorySession;
  const load = useRead(`session|${projectId}|${sessionId}`, get ? () => get.call(bridge, projectId, sessionId) : null, tick, isNotFound);
  return load.status === "none" ? { status: "error", message: "This session is gone." } : load;
}
