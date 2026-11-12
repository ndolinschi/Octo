import type { Agent, ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { useAllRequests, type Reply } from "../../state/requests";

export type ProjectAgents = { project: ProjectSummary; agents: Agent[] };

/**
 * Home's data (decisions 22, 23, 75): every project's agents (`listAgents`, cached per `updated_at`, at most 4 in
 * flight), its orchestrator's state, and the orchestrator's latest reply (the request cache). `agents` is null until
 * it is in, so "Agents at work" can show its skeleton.
 */
export function useOverview() {
  const { projects } = useApp();
  const activity = useActivity();
  const [agents, setAgents] = useState<ProjectAgents[] | null>(null);
  const requestsByProject = useAllRequests(projects);
  const orchestrators = useOrchestrators(projects);
  const stamp = (projects ?? []).map((p) => `${p.id}:${p.updated_at}`).join(",");

  useEffect(() => {
    if (!projects) return;
    let cancelled = false;
    // A project whose agents cannot be read is left out of the cards (the next refresh tries again).
    void Promise.all(
      projects.map((p) =>
        activity.agentsOf(p).then(
          (list) => ({ project: p, agents: list }),
          () => ({ project: p, agents: [] as Agent[] }),
        ),
      ),
    ).then((all) => !cancelled && setAgents(all));
    return () => {
      cancelled = true;
    };
    // `stamp` stands for `projects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, activity]);

  const replies = useMemo(() => {
    const out = new Map<string, Reply | null>();
    for (const p of projects ?? []) {
      const entry = requestsByProject.get(p.id);
      if (entry) out.set(p.id, entry.reply);
    }
    return out;
  }, [projects, requestsByProject]);

  return { projects, agents, replies, orchestrators };
}
