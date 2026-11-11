import type { Project, ProjectInput } from "@octo/agent-client";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";

/** Per-project rows show at most this many projects (newest activity first); the rest are in each project's settings. */
const MAX_PROJECTS = 24;

export type ProjectDetails = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; projects: Project[]; more: number };

/**
 * The full records of the projects (models, memory, budget) for the per-project rows of Editor, Usage and Memory, and
 * `update`, which patches one project and keeps the row in step with what the harness stored.
 */
export function useProjectDetails(): { details: ProjectDetails; update(id: string, patch: Partial<ProjectInput>): Promise<void>; retry(): void } {
  const { bridge, projects } = useApp();
  const [details, setDetails] = useState<ProjectDetails>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const ids = (projects ?? [])
    .slice()
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, MAX_PROJECTS)
    .map((p) => p.id)
    .join("\n");
  const total = projects?.length ?? 0;
  const known = projects !== null;

  useEffect(() => {
    if (!known) return;
    let live = true;
    Promise.all(ids ? ids.split("\n").map((id) => bridge.getProject(id)) : []).then(
      (list) => live && setDetails({ status: "ready", projects: list, more: Math.max(0, total - list.length) }),
      (e: unknown) => live && setDetails({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      live = false;
    };
  }, [bridge, ids, total, known, attempt]);

  const update = useCallback(
    async (id: string, patch: Partial<ProjectInput>) => {
      const next = await bridge.updateProject(id, patch);
      setDetails((d) => (d.status === "ready" ? { ...d, projects: d.projects.map((p) => (p.id === id ? next : p)) } : d));
    },
    [bridge],
  );
  const retry = useCallback(() => {
    setDetails({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { details, update, retry };
}
