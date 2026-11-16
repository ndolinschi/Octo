import { Users } from "lucide-react";
import { agentActivity, runningAgents, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { Glyph } from "../primitives/Glyph";
import { Button } from "../primitives/Button";
import { StateGlyph } from "../primitives/StateGlyph";
import { useOpenSessions } from "./openSessions";

/**
 * Decision 91g: the open project's sub-agents are ONE quiet button, "N agents", at the end of the top row's strip before the
 * commands — never between the tabs and "+" and never one chip per role. The working ring shows only while an agent runs (it
 * has its own 16px slot, so the strip does not change width when a run starts or ends). It opens the agents list
 * (`openSessions`: the Sessions tab filtered to the current session's running agents). Only running agents are shown;
 * nothing shows when no agents are running. `compact` (a narrow strip, decision 90): the glyph and the count; the name and
 * the tooltip keep "N agents". The label stays in the layout, hidden, so the strip can measure what folding gives back.
 */
export function ProjectTeam({ orchestrator, compact = false }: { orchestrator: OrchestratorState; compact?: boolean }) {
  const { state, project } = useProject();
  const openSessions = useOpenSessions();
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : runningAgents(agents);
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
      className="relative"
      title={`${detail}\nOpens the agents list`}
      aria-label={working ? `${label}, working` : label}
      onClick={() => openSessions(project.id)}
    >
      <span aria-hidden className="grid size-4 place-items-center">
        {/* Polish step 2 (F3): the slot always shows a glyph (the people glyph at rest), like its neighbours' play glyphs. */}
        {working ? <StateGlyph state="working" /> : <Glyph icon={Users} size={14} />}
      </span>
      {compact && <span aria-hidden>{team.length}</span>}
      <span data-team-label aria-hidden={compact || undefined} className={compact ? "pointer-events-none invisible absolute" : undefined}>
        {label}
      </span>
    </Button>
  );
}
