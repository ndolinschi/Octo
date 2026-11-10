import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { navigate, useGuardedRoute } from "../lib/route";
import { useUnseen } from "../lib/seen";
import { useApp } from "../state/app";
import { NavProvider, useNav } from "../state/nav";
import { ProjectProvider } from "../state/project";
import { RequestsProvider } from "../state/requests";
import { Button } from "../components/primitives/Button";
import { Dialog } from "../components/primitives/Dialog";
import { Presence, usePresence } from "../components/primitives/Presence";
import { NoProjectsHero } from "../components/project/NoProjectsHero";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { CommandPalette, type PaletteAction } from "../components/shell/CommandPalette";
import { OfflineState } from "../components/shell/OfflineState";
import { Panel } from "../components/shell/Panel";
import { SettingsDialog } from "../components/shell/SettingsDialog";
import { Sidebar } from "../components/shell/Sidebar";
import { TopBar } from "../components/shell/TopBar";
import { ProjectWorkspace } from "./ProjectWorkspace";

/** Below this width the sidebar becomes an overlay drawer, closed by default. */
const DRAWER_QUERY = "(max-width: 999px)";

export function AppShell() {
  return (
    <NavProvider>
      <RequestsProvider>
        <Shell />
      </RequestsProvider>
    </NavProvider>
  );
}

function Shell() {
  const { health, projects, bridge, refreshProjects } = useApp();
  const nav = useNav();
  // Leaving a project with unsaved editor changes asks first.
  const { route, pending, proceed, stay } = useGuardedRoute(
    (next, current) => current.projectId !== null && next.projectId !== current.projectId && nav.unsavedCount() > 0,
  );
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const [inlineOpen, setInlineOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [palette, setPalette] = useState(false);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const sidebarOpen = drawerMode ? drawerOpen : inlineOpen;

  const known = projects?.some((p) => p.id === route.projectId) ?? false;
  // Tracked here, not in the sidebar, so it runs while the sidebar drawer is closed too.
  const unseen = useUnseen(projects, known ? route.projectId : null);
  const firstId = projects?.[0]?.id ?? null;

  useEffect(() => {
    if (health !== "online" || projects === null) return;
    if (!known && firstId) navigate(firstId);
  }, [health, projects, known, firstId]);

  // The drawer closes on navigation and whenever the window grows out of drawer mode.
  useEffect(() => setDrawerOpen(false), [route.projectId, route.agentId, drawerMode]);
  useEscape(drawerMode && drawerOpen && !palette && !settings, () => setDrawerOpen(false));

  // Ctrl/Cmd+K toggles the palette from anywhere, the editor included (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
  const openSettings = () => {
    setDrawerOpen(false);
    setSettings(true);
  };
  const openPalette = () => {
    setDrawerOpen(false);
    setPalette(true);
  };

  const workspace = health !== "offline" && known && route.projectId !== null;
  let main: React.ReactNode = null;
  if (health === "offline") main = <OfflineState />;
  else if (projects && projects.length === 0) main = <NoProjectsHero onCreate={newProject} />;

  const drawerShown = drawerMode && drawerOpen;
  const sidebarProps = {
    activeProjectId: route.projectId,
    activeAgentId: route.agentId,
    unseen,
    onNewProject: newProject,
    onSearch: openPalette,
    onSettings: openSettings,
  };

  const actions: PaletteAction[] = [
    { id: "new", label: "New project", run: newProject },
    { id: "settings", label: "Open settings", run: openSettings },
    { id: "sidebar", label: "Toggle sidebar", run: toggleSidebar },
  ];

  return (
    <div className="flex h-full overflow-hidden bg-window text-fg">
      {!drawerMode && inlineOpen && <Sidebar {...sidebarProps} />}
      <div
        className={cn("relative flex min-w-0 flex-1 flex-col pr-1.5 pb-1.5 max-sm:p-0", !drawerMode && inlineOpen ? "pl-0" : "pl-1.5")}
        inert={drawerShown}
      >
        {workspace && route.projectId ? (
          <ProjectProvider key={route.projectId} projectId={route.projectId}>
            <ProjectWorkspace agentId={route.agentId} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
          </ProjectProvider>
        ) : (
          <>
            <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
            <Panel className="flex-1">{main}</Panel>
          </>
        )}
      </div>
      <Presence show={drawerShown}>
        <SidebarDrawer onClose={() => setDrawerOpen(false)} opener={drawerOpener}>
          <Sidebar {...sidebarProps} onClose={() => setDrawerOpen(false)} />
        </SidebarDrawer>
      </Presence>
      <Presence show={creating}>
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const project = await bridge.createProject(input);
            await refreshProjects();
            setCreating(false);
            navigate(project.id);
          }}
        />
      </Presence>
      <Presence show={settings}>
        <SettingsDialog onClose={() => setSettings(false)} />
      </Presence>
      <Presence show={palette}>
        <CommandPalette openProjectId={known ? route.projectId : null} actions={actions} onClose={() => setPalette(false)} />
      </Presence>
      <Presence show={pending}>
        <LeaveDialog
          count={nav.unsavedCount()}
          onStay={() => {
            nav.clearPendingTurn();
            stay();
          }}
          onLeave={proceed}
        />
      </Presence>
    </div>
  );
}

function LeaveDialog(props: { count: number; onStay(): void; onLeave(): void }) {
  const files = props.count === 1 ? "1\u00a0file has" : `${props.count}\u00a0files have`;
  return (
    <Dialog
      width="sm"
      title="Discard unsaved changes?"
      description={`${files} unsaved edits in this project. Leaving the project discards them.`}
      onClose={props.onStay}
      footer={
        <>
          <Button onClick={props.onStay} data-autofocus>
            Stay
          </Button>
          <Button variant="danger" onClick={props.onLeave}>
            Discard and leave
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

/** Fixed overlay with a scrim; takes focus on open and gives it back as soon as it starts closing. */
function SidebarDrawer(props: { onClose(): void; opener: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  const { onClose, opener, children } = props;
  const panel = useRef<HTMLDivElement>(null);
  const state = usePresence();
  useEffect(() => {
    const el = panel.current;
    (el?.querySelector<HTMLElement>('a[aria-current="page"]') ?? el?.querySelector<HTMLElement>("button:not([disabled]), a[href]"))?.focus();
  }, []);
  useEffect(() => {
    if (state === "closed" && opener.current?.isConnected) opener.current.focus();
  }, [state, opener]);
  return (
    <div className="fixed inset-0 z-40" inert={state === "closed"}>
      <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div ref={panel} data-state={state} className="octo-drawer absolute inset-y-0 left-0 max-w-[calc(100%-48px)] overscroll-contain shadow-pop">
        {children}
      </div>
    </div>
  );
}
