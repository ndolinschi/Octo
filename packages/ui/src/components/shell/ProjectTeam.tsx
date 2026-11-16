import { Users } from "lucide-react";
import { agentActivity, runningAgents, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { StateGlyph } from "../primitives/StateGlyph";
import { useOpenSessions, useOpenSessionTab } from "./openSessions";

/**
 * Decision 91g: the open project's sub-agents are ONE quiet button, "N agents", at the end of the top row's strip before the
 * commands — never between the tabs and "+" and never one chip per role. When 0 sub-agents are running (e.g. right after
 * initial project setup), a quiet icon button opens the project's session in its own tab.
 */
export function ProjectTeam({ orchestrator, compact = false }: { orchestrator: OrchestratorState; compact?: boolean }) {
  const { state, project } = useProject();
  const openSessions = useOpenSessions();
  const openSessionTab = useOpenSessionTab();
  if (!project) return null;
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : runningAgents(agents);
  if (team.length === 0) {
    return (
      <IconButton
        icon={GLYPH.sessions}
        size="sm"
        label="Open project session in a tab"
        title="Open project session in a new tab"
        data-team-button
        className="shrink-0"
        onClick={() => void openSessionTab(project.id)}
      />
    );
  }
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
