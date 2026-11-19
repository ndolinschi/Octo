import { lazy, Suspense } from "react";
import { navigate } from "../lib/route";
import { useApp } from "../state/app";
import { useProject } from "../state/project";
import { Presence } from "../components/primitives/Presence";

const ProjectDialog = lazy(() => import("../components/project/ProjectDialog").then((m) => ({ default: m.ProjectDialog })));

/** The open project's settings (its "⋯" → Settings): its own chunk, loaded on first open (entry budget, decision 98). */
export default function ProjectSettingsDialog({ show, onClose }: { show: boolean; onClose(): void }) {
  const { bridge, refreshProjects, projects } = useApp();
  const { project, update, projectId } = useProject();
  return (
    <Presence show={show && project !== null}>
      {project && (
        <Suspense fallback={null}>
          <ProjectDialog
            project={project}
            onClose={onClose}
            onSubmit={async (input) => {
              await update(input);
              onClose();
            }}
            onDelete={async () => {
              const { deleteProjectCleanly } = await import("../lib/deleteProject");
              await deleteProjectCleanly(bridge, projectId);
              onClose();
              const next = projects?.find((p) => p.id !== projectId);
              navigate(next?.id ?? null);
              await refreshProjects();
            }}
          />
        </Suspense>
      )}
    </Presence>
  );
}
