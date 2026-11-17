import { useEffect, useMemo, useState } from "react";
import { commandRuns, writtenFiles, type WrittenFile } from "../../lib/toolsMore";
import { useActivity, useActivityVersion } from "../../state/activity";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { agentsInSession, filterMessagesForSession } from "./sessionDetails";

export type FileGroup = { label: string; files: (WrittenFile & { count: number })[] };

const DAY = 86_400_000;

/** Today / This week / Earlier, newest first, one row per path (with how often it was written). */
export function groupWrites(writes: WrittenFile[], now: number): FileGroup[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const byPath = new Map<string, WrittenFile & { count: number }>();
  for (const w of [...writes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const key = `${w.folder}/${w.path}`;
    const hit = byPath.get(key);
    if (hit) hit.count += 1;
    else byPath.set(key, { ...w, count: 1 });
  }
  const [todayGroup, weekGroup, earlierGroup]: [FileGroup, FileGroup, FileGroup] = [
    { label: "Today", files: [] },
    { label: "This week", files: [] },
    { label: "Earlier", files: [] },
  ];
  const groups = [todayGroup, weekGroup, earlierGroup];
  for (const f of byPath.values()) {
    const t = Date.parse(f.at);
    (t >= today ? todayGroup : t >= today - 6 * DAY ? weekGroup : earlierGroup).files.push(f);
  }
  return groups.filter((g) => g.files.length);
}

/**
 * Files written by this session's (or project's, on older harnesses) agents (contract v6 decision 17), read lazily
 * from their stored transcripts — one `listMessages` per agent, at most 4 in flight, cached per agent
 * `finished_at` — and read again when an agent changes a file. Null until the first pass is complete.
 */
export type Writes = { files: WrittenFile[]; /** When a command ran (its changes are not tracked as files). */ commands: string[] };

export function useWrittenFiles(extraFolders: readonly { label: string; path: string }[] = []): Writes | null {
  const { project, state, projectId, onEvent } = useProject();
  const scope = useSessionScope();
  const sid = scope?.sessionId ?? null;
  const rootId = project?.orchestrator_agent_id ?? "";
  const activity = useActivity();
  const version = useActivityVersion(activity);
  const scopeKey = `${projectId}:${sid ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; writes: Writes } | null>(null);
  const agents = useMemo(() => agentsInSession(state.agents, state.agentOrder, sid, rootId), [state.agentOrder, state.agents, sid, rootId]);
  // Only what decides a re-read: the scoped agents and when they finished.
  const stamp = `${scopeKey}|${agents.map((a) => `${a.id}:${a.finished_at ?? a.status}`).join(",")}`;
  const projectFolders = project?.folders;
  const foldersKey = extraFolders.map((f) => `${f.label}:${f.path}`).join("|");
  const searchFolders = useMemo(
    () => (projectFolders ? [...extraFolders, ...projectFolders] : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectFolders, foldersKey],
  );

  useEffect(() => onEvent((e) => e.type === "file.changed" && e.source === "agent" && activity.invalidate(projectId)), [onEvent, activity, projectId]);

  useEffect(() => {
    if (!searchFolders) return;
    let cancelled = false;
    // An agent whose transcript cannot be read is left out of the list (it shows again on the next refresh).
    void Promise.all(agents.map((a) => activity.transcript(projectId, a).catch(() => []))).then((lists) => {
      if (cancelled) return;
      const scoped = lists.map((messages) => filterMessagesForSession(messages, sid));
      setLoaded({
        key: scopeKey,
        writes: {
          files: scoped.flatMap((messages) => writtenFiles(messages, searchFolders)),
          commands: scoped.flatMap((messages) => commandRuns(messages)),
        },
      });
    });
    return () => {
      cancelled = true;
    };
    // `stamp` stands for `agents`, `scopeKey`, and `sid`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, version, searchFolders, activity, projectId]);

  return loaded?.key === scopeKey ? loaded.writes : null;
}
