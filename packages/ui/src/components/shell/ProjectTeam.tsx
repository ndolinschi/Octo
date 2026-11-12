import { agentActivity, lastTeam, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { StateGlyph } from "../primitives/StateGlyph";
import { useOpenSessions } from "./openSessions";

/**
 * Decision 91g: the open project's sub-agents are ONE quiet button, "N agents", at the end of the top row's strip before the
 * commands — never between the tabs and "+" and never one chip per role. The working ring shows only while an agent runs (it
 * has its own 16px slot, so the strip does not change width when a run starts or ends). It opens the agents list
 * (`openSessions`: the Sessions tab filtered to the current session's agents). The team is the running agents while it works, the latest turn's team when idle
 * or failed; nothing shows before the first request.
 */
export function ProjectTeam({ orchestrator }: { orchestrator: OrchestratorState }) {
  const { state, project } = useProject();
  const openSessions = useOpenSessions();
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : orchestrator.kind === "new" ? [] : lastTeam(agents);
  if (team.length === 0 || !project) return null;
  const working = orchestrator.kind === "working";
  const label = `${team.length} ${team.length === 1 ? "agent" : "agents"}`;
  const roles = teamRoles(team);
  const detail = roles
    .map((r) => `${r.role}${r.count > 1 ? ` ×${r.count}` : ""}${r.status === "running" ? ` — ${agentActivity(state, r.agent.id)}` : ""}`)
    .join("\n");
  return (
    <Button
      variant="quiet"
      size="sm"
      data-team-button
      title={`${detail}\nOpens the agents list`}
      aria-label={working ? `${label}, working` : label}
      onClick={() => openSessions(project.id)}
    >
      <span aria-hidden className="grid size-4 place-items-center">
        {working && <StateGlyph state="working" />}
      </span>
      {label}
    </Button>
  );
}
