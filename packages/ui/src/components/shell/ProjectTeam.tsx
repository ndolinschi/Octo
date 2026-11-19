import { Users } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { runningAgents, type OrchestratorState } from "../../lib/orchestrator";
import { agentActivity, teamRoles } from "../../lib/orchestratorMore";
import { useProject } from "../../state/project";
import { useTabFlags } from "../../state/tabFlags";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
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
 * commands — never between the tabs and "+" and never one chip per role. Beside it (when `tabFlags.sessions` is enabled), a
 * quiet sessions button opens the session selector to switch, open in a tab, or start a new session.
 */
export function ProjectTeam({ orchestrator, compact = false }: { orchestrator: OrchestratorState; compact?: boolean }) {
  const { state, project } = useProject();
  const tabFlags = useTabFlags();
  const ws = useOptionalWorkspace();
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
  const teamHint = tabFlags.sessions || tabFlags.agents ? "Opens the agents list" : "Opens the running agent";
  return (
    <>
      {tabFlags.sessions && (
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
      )}
      {team.length > 0 && (
        <Button
          variant="quiet"
          size="sm"
          data-team-button
          className="relative"
          title={`${detail}\n${teamHint}`}
          aria-label={working ? `${label}, working` : label}
          onClick={() => {
            if (tabFlags.sessions) openSessions(project.id);
            else if (tabFlags.agents) ws?.openTool("agents");
            else if (team[0]) ws?.openAgent(team[0].id);
          }}
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
      <Presence show={tabFlags.sessions && pickerOpen} exitMs={0}>
        {tabFlags.sessions && pickerOpen && (
          <Suspense fallback={null}>
            <ProjectSessionPicker anchor={buttonRef} onClose={() => setPickerOpen(false)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
