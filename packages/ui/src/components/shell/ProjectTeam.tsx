import { Users } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { agentActivity, runningAgents, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Presence } from "../primitives/Presence";
import { StateGlyph } from "../primitives/StateGlyph";
import { useOpenSessions } from "./openSessions";

const ProjectSessionPicker = lazy(() => import("./ProjectSessionPicker"));

/**
 * Decision 91g: the open project's sub-agents are ONE quiet button, "N agents", at the end of the top row's strip before the
 * commands — never between the tabs and "+" and never one chip per role. Beside it (and always present when 0 agents are
 * running), a quiet sessions button opens the session selector to switch, open in a tab, or start a new session.
 */
export function ProjectTeam({ orchestrator, compact = false }: { orchestrator: OrchestratorState; compact?: boolean }) {
  const { state, project } = useProject();
  const openSessions = useOpenSessions();
  const [pickerOpen, setPickerOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : runningAgents(agents);
  const working = orchestrator.kind === "working";
  const label = `${team.length} ${team.length === 1 ? "agent" : "agents"}`;
  const roles = team.length > 0 ? teamRoles(team) : [];
  const detail = roles
    .map((r) => `${r.role}${r.count > 1 ? ` ×${r.count}` : ""}${r.status === "running" ? ` — ${agentActivity(state, r.agent.id)}` : ""}`)
    .join("\n");
  return (
    <>
      <IconButton
        ref={buttonRef}
        icon={GLYPH.sessions}
        size="sm"
        label="Sessions"
        title="Switch or start a session"
        data-sessions-button
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        className={cn("shrink-0", pickerOpen && "bg-active text-fg")}
        onClick={() => setPickerOpen((o) => !o)}
      />
      {team.length > 0 && (
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
      )}
      <Presence show={pickerOpen} exitMs={0}>
        {pickerOpen && (
          <Suspense fallback={null}>
            <ProjectSessionPicker anchor={buttonRef} onClose={() => setPickerOpen(false)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
