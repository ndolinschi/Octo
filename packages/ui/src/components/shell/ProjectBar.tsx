import { Ellipsis } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { liveOrchestratorState } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Presence } from "../primitives/Presence";
import type { Failure } from "./ProjectActionsMenu";
import { ProjectTeam } from "./ProjectTeam";

const ProjectActionsMenu = lazy(() => import("./ProjectActionsMenu"));
const ErrorNotice = lazy(() => import("../shared/ErrorNotice").then((m) => ({ default: m.ErrorNotice })));

/**
 * What the open project puts in the window's top row (decision 67; the row is the tab strips, `dock/TabStrip`). Next to the
 * conversation's tab: its sub-agents (`ProjectTeamLine`, decision 34); at the far end of the last strip: the "⋯" menu with the project's actions (`ProjectActions`). The model is chosen
 * in the composer only. Project commands (decision 68) sit before the actions: `commands/ProjectCommands`, mounted by `dock/TabStrip` (features do not import each other).
 */
export function ProjectTeamLine({ compact = false }: { compact?: boolean }) {
  const { project, state, running } = useProject();
  const orchestrator = useMemo(() => liveOrchestratorState(state, running ? "running" : "idle"), [state, running]);
  if (!project) return null;
  return <ProjectTeam orchestrator={orchestrator} compact={compact} />;
}

export function ProjectActions() {
  const { project } = useProject();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  return (
    <>
      <span className="flex shrink-0 items-center gap-1">
        <IconButton
          ref={button}
          icon={Ellipsis}
          label="Project actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={cn(menu && "bg-active text-fg")}
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
          }}
        />
      </span>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Suspense fallback={null}>
            <ProjectActionsMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onFailure={setFailure} />
          </Suspense>
        )}
      </Presence>
      {failure && (
        <div role="alert" className="fixed top-12 right-3 z-[60] w-96 max-w-[calc(100vw-1.5rem)]">
          <Suspense fallback={null}>
            <ErrorNotice
              fields={failure}
              raw={failure.message}
              title="Could not export"
              actions={
                <Button size="sm" variant="quiet" onClick={() => setFailure(null)}>
                  Dismiss
                </Button>
              }
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
