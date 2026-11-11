import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { focusSoon, visibleComposer } from "../lib/focus";
import { navigate, useGuardedRoute } from "../lib/route";
import { useUnseen } from "../lib/seen";
import { useApp } from "../state/app";
import { NavProvider, useNav } from "../state/nav";
import { ProjectProvider } from "../state/project";
import { RequestsProvider } from "../state/requests";
import { ShellContext } from "../state/shell";
import { Button } from "../components/primitives/Button";
import { Dialog } from "../components/primitives/Dialog";
import { Presence, usePresence } from "../components/primitives/Presence";
import { NoProjectsHero } from "../components/project/NoProjectsHero";
import type { PaletteAction } from "../components/shell/CommandPalette";
import { OfflineState } from "../components/shell/OfflineState";
import { Panel } from "../components/shell/Panel";
import type { SettingsView } from "../components/shell/SettingsDialog";
import { Sidebar } from "../components/shell/Sidebar";
import { TitleBar } from "../components/shell/TitleBar";
import { TitleBarSlotsContext } from "../state/titleBar";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ActivityProvider } from "../state/activity";
import { DRAWER_QUERY } from "../lib/constants";

/** Home loads on first visit (its own chunk); the app usually opens a project. */
/** The palette loads after the first paint (idle) or on first use, whichever comes first (its own chunk). */
const loadPalette = () => import("../components/shell/CommandPalette");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
/** Demo-only `#/p/<id>/memory` (the Memory view on its own); not in a normal start's chunks. */
const MemoryRoute = lazy(() => import("./MemoryRoute").then((m) => ({ default: m.MemoryRoute })));
const Home = lazy(() => import("../components/home/Home").then((m) => ({ default: m.Home })));
/** The project and settings dialogs load on first use, warmed with the palette (their own chunks; v6.3 bundle). */
const loadDialogs = () => Promise.all([import("../components/project/ProjectDialog"), import("../components/shell/SettingsDialog")]);
const ProjectDialog = lazy(() => import("../components/project/ProjectDialog").then((m) => ({ default: m.ProjectDialog })));
const SettingsDialog = lazy(() => import("../components/shell/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));

/** Below this width the sidebar becomes an overlay drawer, closed by default. */

export function AppShell() {
  return (
    <NavProvider>
      <RequestsProvider>
        <ActivityProvider>
          <Shell />
        </ActivityProvider>
      </RequestsProvider>
    </NavProvider>
  );
}

function Shell() {
  const { health, projects, bridge, refreshProjects, demo } = useApp();
  const nav = useNav();
  // Leaving a project with unsaved editor changes asks first.
  const { route, pending, proceed, stay } = useGuardedRoute(
    (next, current) => current.projectId !== null && next.projectId !== current.projectId && nav.unsavedCount() > 0,
  );
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const [inlineOpen, setInlineOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [palette, setPalette] = useState(false);
  const drawerOpener = useRef<HTMLElement | null>(null);
  // The two ends of the title bar row that the open project fills (see `TitleBarProject`).
  const [titleStart, setTitleStart] = useState<HTMLElement | null>(null);
  const [titleEnd, setTitleEnd] = useState<HTMLElement | null>(null);
  const sidebarOpen = drawerMode ? drawerOpen : inlineOpen;

  const known = projects?.some((p) => p.id === route.projectId) ?? false;
  // Tracked here, not in the sidebar, so it runs while the sidebar drawer is closed too.
  const unseen = useUnseen(projects, known ? route.projectId : null);
  const firstId = projects?.[0]?.id ?? null;

  // Opening the app (no route) shows the most recently active project, as before; `#/` is Home and stays
  // (decision 22); an unknown project id falls back to the first project.
  const opened = useRef(window.location.hash === "" || window.location.hash === "#");
  useEffect(() => {
    if (health !== "online" || projects === null) return;
    const atHome = route.projectId === null && !opened.current;
    opened.current = false;
    if (!known && firstId && !atHome) navigate(firstId);
  }, [health, projects, known, firstId, route.projectId]);

  // The drawer closes on navigation and whenever the window grows out of drawer mode.
  useEffect(() => setDrawerOpen(false), [route.projectId, route.agentId, drawerMode]);
  useEscape(drawerMode && drawerOpen && !palette && settings === null, () => setDrawerOpen(false));

  // Warm the palette's chunk once the app is idle, so Ctrl/Cmd+K opens it without a wait.
  useEffect(() => {
    // A failed warm-up is retried by the first Ctrl/Cmd+K (which shows the error if it fails again).
    const id = window.setTimeout(() => {
      void loadPalette().catch(() => undefined);
      void loadDialogs().catch(() => undefined);
      // The chunks the first minutes most likely need (v6.3 part 2 moved them out of the initial bundle): warmed, so a
      // file, the "+" picker or the model picker opens without a wait. A failure is retried by the first real open.
      void import("../components/files/FileView").catch(() => undefined);
      void import("../components/dock/TabPicker").catch(() => undefined);
      void import("../components/shared/ModelPickerPanel").catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(id);
  }, []);

  // Ctrl/Cmd+K toggles the palette from anywhere, the editor included (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setPalette((p) => !p);
      }
      // Ctrl/Cmd+L: the caret into the visible composer, from anywhere (Monaco keeps Tab for indenting).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "l" && !document.querySelector('[aria-modal="true"]')) {
        const composer = visibleComposer();
        if (composer) {
          e.preventDefault();
          e.stopPropagation();
          composer.focus();
        }
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
  const openSettings = (view: SettingsView = "general") => {
    setDrawerOpen(false);
    setSettings(view);
  };
  const openPalette = () => {
    setDrawerOpen(false);
    setPalette(true);
  };

  const workspace = health !== "offline" && known && route.projectId !== null;
  let main: React.ReactNode = null;
  if (health === "offline") main = <OfflineState />;
  else if (projects && projects.length === 0) main = <NoProjectsHero onCreate={newProject} />;
  else if (route.projectId === null && projects)
    main = (
      <Suspense fallback={null}>
        <Home
          unseen={unseen}
          onNewProject={newProject}
          onSearch={openPalette}
          onUsage={(projectId) => {
            nav.requestTool({ projectId, tool: "usage", scope: "all" });
            navigate(projectId);
          }}
        />
      </Suspense>
    );

  const drawerShown = drawerMode && drawerOpen;
  const sidebarProps = {
    activeProjectId: route.projectId,
    home: route.projectId === null && (projects?.length ?? 0) > 0,
    unseen,
    onNewProject: newProject,
    onSearch: openPalette,
    onSettings: () => openSettings(),
    // Picking a project closes the drawer even when it is the one already open (the route does not change then).
    onPick: () => setDrawerOpen(false),
  };

  const actions: PaletteAction[] = [
    { id: "home", label: "Go to Home", run: () => navigate(null) },
    { id: "new", label: "New project", run: newProject },
    { id: "settings", label: "Open settings", run: () => openSettings() },
    { id: "integrations", label: "Open integrations", run: () => openSettings("integrations") },
    { id: "sidebar", label: "Toggle sidebar", run: toggleSidebar },
  ];

  return (
    <ShellContext.Provider value={{ sidebarOpen, toggleSidebar }}>
      <TitleBarSlotsContext.Provider value={{ start: titleStart, end: titleEnd }}>
        <div className="flex h-full flex-col overflow-hidden bg-window text-fg">
          {/* Decision 54: the title bar is the header. One row across the window, whether the sidebar is open or closed. */}
          <TitleBar alignStart={!drawerMode && inlineOpen} startRef={setTitleStart} endRef={setTitleEnd} />
          <div className="flex min-h-0 flex-1">
            {!drawerMode && inlineOpen && <Sidebar {...sidebarProps} />}
            {/* Equal gutters on the other sides of every panel (the sidebar card included); the row above is the top one. Full-bleed on phones. */}
            <div className="relative flex min-w-0 flex-1 flex-col p-gutter pt-0 max-sm:p-0" inert={drawerShown}>
              {workspace && route.projectId ? (
                <ProjectProvider key={route.projectId} projectId={route.projectId}>
                  {demo && window.location.hash.endsWith("/memory") ? (
                    <Suspense fallback={null}>
                      <MemoryRoute />
                    </Suspense>
                  ) : (
                    <ProjectWorkspace agentId={route.agentId} />
                  )}
                </ProjectProvider>
              ) : (
                <Panel className="flex-1">
                  <div className="min-h-0 flex-1">{main}</div>
                </Panel>
              )}
            </div>
          </div>
          <Presence show={drawerShown}>
            <SidebarDrawer onClose={() => setDrawerOpen(false)} opener={drawerOpener}>
              <Sidebar {...sidebarProps} />
            </SidebarDrawer>
          </Presence>
          <Presence show={creating}>
            <Suspense fallback={null}>
              <ProjectDialog
                onClose={() => setCreating(false)}
                onSubmit={async (input) => {
                  const project = await bridge.createProject(input);
                  await refreshProjects();
                  setCreating(false);
                  navigate(project.id);
                  // The new project's composer takes focus once the dialog is gone and the project is in.
                  focusSoon(() => document.getElementById("octo-composer"), { delay: 160, timeout: 3000 });
                }}
              />
            </Suspense>
          </Presence>
          <Presence show={settings !== null}>
            <Suspense fallback={null}>
              <SettingsDialog initialView={settings ?? "general"} onClose={() => setSettings(null)} />
            </Suspense>
          </Presence>
          <Presence show={palette}>
            <Suspense fallback={null}>
              <CommandPalette openProjectId={known ? route.projectId : null} actions={actions} onClose={() => setPalette(false)} />
            </Suspense>
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
      </TitleBarSlotsContext.Provider>
    </ShellContext.Provider>
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
    // Starts under the title bar row, so its toggle stays reachable (it closes the drawer).
    <div className="fixed inset-x-0 top-bar bottom-0 z-40" inert={state === "closed"}>
      <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div ref={panel} data-state={state} className="octo-drawer absolute inset-y-0 left-0 max-w-[calc(100%-48px)] overscroll-contain shadow-pop">
        {children}
      </div>
    </div>
  );
}
