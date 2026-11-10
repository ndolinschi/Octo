import { useEffect, useRef, useState } from "react";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { navigate, useRoute } from "../lib/route";
import { useApp } from "../state/app";
import { ProjectProvider } from "../state/project";
import { NoProjectsHero } from "../components/project/NoProjectsHero";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { OfflineState } from "../components/shell/OfflineState";
import { Sidebar } from "../components/shell/Sidebar";
import { TopBar } from "../components/shell/TopBar";
import { ProjectWorkspace } from "./ProjectWorkspace";

/** Below this width the sidebar becomes an overlay drawer, closed by default. */
const DRAWER_QUERY = "(max-width: 999px)";

export function AppShell() {
  const { health, projects, bridge, refreshProjects } = useApp();
  const route = useRoute();
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const [inlineOpen, setInlineOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const sidebarOpen = drawerMode ? drawerOpen : inlineOpen;

  const known = projects?.some((p) => p.id === route.projectId) ?? false;
  const firstId = projects?.[0]?.id ?? null;

  useEffect(() => {
    if (health !== "online" || projects === null) return;
    if (!known && firstId) navigate(firstId);
  }, [health, projects, known, firstId]);

  // The drawer closes on navigation and whenever the window grows out of drawer mode.
  useEffect(() => setDrawerOpen(false), [route.projectId, route.agentId, drawerMode]);
  useEscape(drawerMode && drawerOpen, () => setDrawerOpen(false));

  const toggleSidebar = () => {
    if (!drawerMode) return setInlineOpen((o) => !o);
    // Remember the opener now: once the main column goes inert it loses focus.
    if (!drawerOpen) drawerOpener.current = document.activeElement as HTMLElement | null;
    setDrawerOpen((o) => !o);
  };
  const newProject = () => {
    setDrawerOpen(false);
    setCreating(true);
  };

  let main: React.ReactNode = null;
  if (health === "offline") main = <OfflineState />;
  else if (projects && projects.length === 0) main = <NoProjectsHero onCreate={newProject} />;
  else if (known && route.projectId) {
    main = (
      <ProjectProvider key={route.projectId} projectId={route.projectId}>
        <ProjectWorkspace
          agentId={route.agentId}
          sidebarOpen={sidebarOpen}
          sidebarIsDrawer={drawerMode}
          onToggleSidebar={toggleSidebar}
        />
      </ProjectProvider>
    );
  }

  const workspace = health !== "offline" && known;
  const drawerShown = drawerMode && drawerOpen;

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {!drawerMode && inlineOpen && <Sidebar activeProjectId={route.projectId} onNewProject={newProject} />}
      <div className="relative flex min-w-0 flex-1 flex-col" inert={drawerShown}>
        {!workspace && <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />}
        <div className="min-h-0 flex-1">{main}</div>
      </div>
      {drawerShown && (
        <SidebarDrawer onClose={() => setDrawerOpen(false)} opener={drawerOpener}>
          <Sidebar activeProjectId={route.projectId} onNewProject={newProject} onClose={() => setDrawerOpen(false)} />
        </SidebarDrawer>
      )}
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

/** Fixed overlay with a scrim; takes focus on open and gives it back on close. */
function SidebarDrawer(props: { onClose(): void; opener: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  const { onClose, opener, children } = props;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("a[aria-current], button:not([disabled]), a[href]")?.focus();
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [opener]);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-scrim" onMouseDown={onClose} aria-hidden />
      <div ref={panel} className="absolute inset-y-0 left-0 max-w-[calc(100%-48px)] shadow-pop">
        {children}
      </div>
    </div>
  );
}
