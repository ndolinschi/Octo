import type { Agent } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { servedModel } from "../../lib/models";
import { turnLine } from "../../lib/usage/turnLine";
import { useApp } from "../../state/app";
import { useAcpNames } from "../../state/models";
import { useProject } from "../../state/project";

/**
 * Decision 86 d: "model · 12k in / 3.1k out" for the newest finished turn of the orchestrator, read from the context
 * report's `last_request` (the harness keeps usage per request, not per turn: older turns say nothing). It is read once
 * when a turn ends and once on mount; a harness without the report, or a failed read, leaves the line out.
 */
export function useTurnLine(agent: Pick<Agent, "model" | "served_model"> | undefined, active: boolean, running: boolean): string | null {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const acp = useAcpNames();
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  useEffect(() => {
    if (!active || running || !bridge.getContextOverview) return;
    let live = true;
    bridge.getContextOverview(projectId).then(
      (overview) => {
        const last = overview.last_request;
        if (live) setUsage(last ? { input: last.input, output: last.output } : null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge, projectId, active, running]);
  if (!active || !agent || !usage) return null;
  return turnLine({ model: servedModel(agent, acp).name, inputTokens: usage.input, outputTokens: usage.output });
}
