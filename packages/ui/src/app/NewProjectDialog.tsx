import { focusSoon } from "../lib/focus";
import { navigate } from "../lib/route";
import { useApp } from "../state/app";
import { ProjectDialog } from "../components/project/ProjectDialog";

/** "New project": the dialog and what creating does (its own chunk with the dialog, warmed on idle and on intent). */
export function NewProjectDialog({ onClose }: { onClose(): void }) {
  const { bridge, refreshProjects } = useApp();
  return (
    <ProjectDialog
      onClose={onClose}
      onSubmit={async (input) => {
        const project = await bridge.createProject(input);
        await refreshProjects();
        onClose();
        navigate(project.id);
        // The new project's composer takes focus once the dialog is gone and the project is in.
        focusSoon(() => document.getElementById("octo-composer"), { delay: 160, timeout: 3000 });
      }}
    />
  );
}
