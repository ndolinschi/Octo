import { useEffect, useState } from "react";
import { useMediaQuery } from "../lib/hooks";
import { navigate, useRoute } from "../lib/route";
import { useApp } from "../state/app";
import { ProjectProvider } from "../state/project";
import { NoProjectsHero } from "../components/project/NoProjectsHero";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { OfflineState } from "../components/shell/OfflineState";
import { Sidebar } from "../components/shell/Sidebar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { IconButton } from "../components/primitives/Button";
import { PanelLeft } from "lucide-react";

export function AppShell() {
  const { health, projects, bridge, refreshProjects } = useApp();
  const route = useRoute();
  const narrow = useMediaQuery("(max-width: 999px)");
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [creating, setCreating] = useState(false);

  const known = projects?.some((p) => p.id === route.projectId) ?? false;
  const firstId = projects?.[0]?.id ?? null;

  useEffect(() => {
    if (health !== "online" || projects === null) return;
    if (!known && firstId) navigate(firstId);
  }, [health, projects, known, firstId]);

  let main: React.ReactNode = null;
  if (health === "offline") main = <OfflineState />;
  else if (projects && projects.length === 0) main = <NoProjectsHero onCreate={() => setCreating(true)} />;
  else if (known && route.projectId) {
    main = (
      <ProjectProvider key={route.projectId} projectId={route.projectId}>
        <ProjectWorkspace agentId={route.agentId} sidebarOpen={sidebarOpen} onOpenSidebar={() => setSidebarOpen(true)} />
      </ProjectProvider>
    );
  }

  const workspace = health !== "offline" && known;

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {sidebarOpen && (
        <Sidebar activeProjectId={route.projectId} onNewProject={() => setCreating(true)} onCollapse={() => setSidebarOpen(false)} />
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen && !workspace && (
          <IconButton icon={PanelLeft} label="Show sidebar" onClick={() => setSidebarOpen(true)} className="absolute top-2.5 left-2.5 z-10" />
        )}
        {main}
      </div>
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const project = await bridge.createProject(input);
            await refreshProjects();
            setCreating(false);
            navigate(project.id);
          }}
        />
      )}
    </div>
  );
}
