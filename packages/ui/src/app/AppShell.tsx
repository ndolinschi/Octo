import { warmBridgeClient } from "@octo/agent-client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { loadPref, PREFS, sidebarViewCodec } from "../lib/storage";
import { useEscape, useLatest, useMediaQuery } from "../lib/hooks";
import { holdTypeahead, takeTypeahead } from "../lib/typeahead";
import { focusSoon, visibleComposer } from "../lib/focus";
import { navigate, resolveProjectRoute, settingsHref, useGuardedRoute, useSettingsSection } from "../lib/route";
import { useProviders } from "../lib/providers/useProviders";
import { startupOpensLast, useStoredMotion } from "../components/settings/prefs";
import { useUnseen } from "../lib/seen";
import { useApp } from "../state/app";
import { useHost } from "../state/host";
import { NavProvider, useNav } from "../state/nav";
import { ProjectProvider } from "../state/project";
import { RequestsProvider } from "../state/requests";
import { ShellContext } from "../state/shell";
import { Presence } from "../components/primitives/Presence";
import type { PaletteAction } from "../components/shell/CommandPalette";
import { Panel } from "../components/shell/Panel";
import { MainSkeleton } from "../components/shell/MainSkeleton";
import { SkeletonList } from "../components/primitives/Skeleton";
import { Sidebar } from "../components/shell/Sidebar";
import { TitleBar } from "../components/shell/TitleBar";
import { StatusBar } from "../components/status/StatusBar";
import { StatusSlotsContext } from "../state/statusSlots";
import { ProjectGone, ProjectWorkspace } from "./ProjectWorkspace";
import { warmDrag } from "../components/dock/drag";
import { transcriptPart } from "../components/chat/transcriptPart";
import { ActivityProvider } from "../state/activity";
import { DRAWER_QUERY } from "../lib/constants";

/** Home loads on first visit (its own chunk); the app usually opens a project. */
/** The palette loads after the first paint (idle) or on first use, whichever comes first (its own chunk). */
const loadPalette = () => import("../components/shell/CommandPalette");
/** The settings index for the palette's Settings group (loaded with the palette). */
const loadSettingsIndex = () => import("../components/settings/settingsIndex");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
/** The shortcuts sheet: its own chunk, mounted for its "?" key; it renders only while open. */
const ShortcutsSheet = lazy(() => import("../components/shell/ShortcutsSheet"));
/** Demo-only `#/p/<id>/memory` (the Memory view on its own); not in a normal start's chunks. */
const MemoryRoute = lazy(() => import("./MemoryRoute").then((m) => ({ default: m.MemoryRoute })));
/** States the app is rarely in: their own chunks (bundle budget). */
const NoProjectsHero = lazy(() => import("../components/project/NoProjectsHero").then((m) => ({ default: m.NoProjectsHero })));
// The same chunk as OfflineState: a chunk of its own would cost the entry more than the banner itself.
const OfflineBanner = lazy(() => import("../components/shell/OfflineState").then((m) => ({ default: m.OfflineBanner })));
const OfflineState = lazy(() => import("../components/shell/OfflineState").then((m) => ({ default: m.OfflineState })));
const Home = lazy(() => import("../components/home/Home").then((m) => ({ default: m.Home })));
/** The project dialog and the settings page load on first use, warmed with the palette (their own chunks; v6.3 bundle). */
const loadDialogs = () => Promise.all([import("../components/project/ProjectDialog"), import("../components/settings/SettingsPage")]);
const ProjectDialog = lazy(() => import("../components/project/ProjectDialog").then((m) => ({ default: m.ProjectDialog })));
const SettingsPage = lazy(() => import("../components/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
/** Decision 53: the connect sheet and the no-provider screen (their own chunks). */
const ConnectSheet = lazy(() => import("../components/providers/ConnectSheet").then((m) => ({ default: m.ConnectSheet })));
const ConnectScreen = lazy(() => import("../components/providers/ConnectScreen").then((m) => ({ default: m.ConnectScreen })));

/** Below this width the sidebar becomes an overlay drawer, closed by default. */

/** Dialogs that only open on a conflict (unsaved edits): their own chunk with `Dialog`, warmed after the first paint. */
const LeaveDialog = lazy(() => import("../components/shell/DiscardDialogs").then((m) => ({ default: m.LeaveDialog })));
/** The sidebar as a drawer exists only under the drawer breakpoint: its own chunk (with the modal hook), warmed after first paint. */
const SidebarDrawer = lazy(() => import("../components/shell/SidebarDrawer").then((m) => ({ default: m.SidebarDrawer })));
/**
 * Decision 96: the sidebar's tree of projects and sessions (and the flat sessions list) is its own chunk, asked for as soon as
 * this module runs, so it is in long before the project list arrives from the service.
 */
const loadTree = () => import("../components/sessions/SessionTree");
const treeChunk = loadTree().catch(() => undefined);
const SessionTree = lazy(() => treeChunk.then((m) => m ?? loadTree()).then((m) => ({ default: m.SessionTree })));

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
  const host = useHost();
  const nav = useNav();
  // Leaving a project with unsaved editor changes asks first.
  const { route, pending, proceed, stay } = useGuardedRoute(
    (next, current) => current.projectId !== null && next.projectId !== current.projectId && nav.unsavedCount() > 0,
  );
  const drawerMode = useMediaQuery(DRAWER_QUERY);

  const [inlineOpen, setInlineOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // Decision 59: Settings is a page at `#/settings/<section>`; "Back" returns to the hash it was opened from.
  const settings = useSettingsSection();
  // Decision 96: what the sidebar lists (Settings → General); read again whenever the settings page opens or closes (the
  // sidebar is hidden while it is open).
  const inSettings = settings !== null;
  const view = useMemo(() => {
    void inSettings;
    return loadPref(PREFS.sidebarView, sidebarViewCodec);
  }, [inSettings]);
  const beforeSettings = useRef("#/");
  // The project open in the app, kept while Settings is on screen (its route has no project): Models opens its project tab on it.
  const [openProject, setOpenProject] = useState<string | null>(route.projectId);
  if (settings === null && openProject !== route.projectId) setOpenProject(route.projectId);
  useEffect(() => {
    if (settings === null) beforeSettings.current = window.location.hash || "#/";
  }, [settings, route]);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  const [useAnyway, setUseAnyway] = useState<(() => void) | null>(null);
  const openConnect = (id: string, anyway?: () => void) => {
    setUseAnyway(() => anyway ?? null);
    setConnectTarget(id);
  };
  // Decision 53 b: nothing connected → the connect screen instead of Home and the project form.
  const providers = useProviders(bridge, health === "online");
  const noProvider = providers.status === "ready" && providers.list.connected === 0;
  useStoredMotion();
  const [palette, setPalette] = useState(false);
  const paletteOpen = useLatest(palette);
  const drawerOpener = useRef<HTMLElement | null>(null);
  // The two ends of the status bar that the open project fills (see `ProjectStatus`).
  const [statusStart, setStatusStart] = useState<HTMLElement | null>(null);
  const [statusEnd, setStatusEnd] = useState<HTMLElement | null>(null);
  const sidebarOpen = drawerMode ? drawerOpen : inlineOpen;

  // P1-4: the route alone says which project is shown and sent to. An id the list lacks is looked up (list and project)
  // instead of falling back to another project; a 404 makes it "missing", even while a stale list still has it.
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const routeState = resolveProjectRoute(route.projectId, projects, missing);
  const known = routeState === "show";
  const lookingUp = useRef<string | null>(null);
  const lookUp = useCallback(
    async (id: string) => {
      if (lookingUp.current === id) return;
      lookingUp.current = id;
      try {
        await bridge.getProject(id);
        await refreshProjects();
      } catch (e) {
        // Not a 404 (offline, 5xx): health polling shows that; the next list change or reconnect looks again.
        if (typeof e === "object" && e !== null && "status" in e && e.status === 404) {
          setMissing((m) => new Set(m).add(id));
          void refreshProjects();
        }
      } finally {
        lookingUp.current = null;
      }
    },
    [bridge, refreshProjects],
  );
  useEffect(() => {
    if (health !== "online" || routeState !== "check" || route.projectId === null) return;
    const id = route.projectId;
    const t = window.setTimeout(() => void lookUp(id), 0);
    return () => window.clearTimeout(t);
  }, [health, routeState, route.projectId, lookUp]);
  // The open project's stream or load failed: it may have been deleted elsewhere (its events answer 404).
  const onProjectLost = useCallback(() => {
    if (route.projectId !== null) void lookUp(route.projectId);
  }, [route.projectId, lookUp]);
  // Tracked here, not in the sidebar, so it runs while the sidebar drawer is closed too.
  const unseen = useUnseen(projects, known ? route.projectId : null);
  const firstId = projects?.[0]?.id ?? null;

  // Opening the app (no route) shows the most recently active project, as before; `#/` is Home and stays
  // (decision 22); an unknown project id is looked up above, never replaced by another project (P1-4).
  // Settings → General → "On startup: Home" keeps Home instead.
  const opened = useRef((window.location.hash === "" || window.location.hash === "#") && startupOpensLast());
  // While it loads into a project, the empty main panel sits where the project's panel will (under the top row on phones too).
  const [startsInProject] = useState(() => route.projectId !== null || ((window.location.hash === "" || window.location.hash === "#") && startupOpensLast()));
  useEffect(() => {
    if (health !== "online" || projects === null) return;
    if (opened.current && route.projectId === null && firstId) navigate(firstId);
    opened.current = false;
  }, [health, projects, firstId, route.projectId]);

  // The drawer closes on navigation and whenever the window grows out of drawer mode.
  useEffect(() => setDrawerOpen(false), [route.projectId, route.agentId, route.sessionId, drawerMode]);
  useEscape(drawerMode && drawerOpen && !palette, () => setDrawerOpen(false));

  // The first assistant message must not flash as plain text before Markdown arrives: fetch that chunk right after first
  // paint (idle callback; WebKit has none, so a short timer), still outside the initial bundle.
  useEffect(() => {
    const warm = () => {
      warmBridgeClient();
      warmDrag();
      void import("../components/shared/Markdown").catch(() => undefined);
      void transcriptPart.fetch().catch(() => undefined);
      void import("../components/chat/ToolGroup").catch(() => undefined);
      void import("../components/chat/DelegationGroup").catch(() => undefined);
      void import("../components/chat/TurnBanner").catch(() => undefined);
      void import("../components/shell/DiscardDialogs").catch(() => undefined);
      void import("../components/primitives/Menu").catch(() => undefined);
      void import("../components/chat/ComposerPills").catch(() => undefined);
      void import("../components/shell/SidebarDrawer").catch(() => undefined);
      void import("../components/chat/ContextRing").catch(() => undefined);
      void import("../components/chat/SessionChip").catch(() => undefined);
    };
    if (Reflect.has(window, "requestIdleCallback")) {
      const id = window.requestIdleCallback(warm, { timeout: 500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 50);
    return () => window.clearTimeout(id);
  }, []);

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
      void import("../components/chat/RoutingLine").catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(id);
  }, []);

  // NEW-6: Back / Forward (or any hash change) closes the transient overlays that are not the new route's own: the palette and
  // the New project dialog (its draft is kept). The shortcuts sheet closes itself the same way.
  useEffect(() => {
    const close = () => {
      setPalette(false);
      setCreating(false);
    };
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  // Ctrl/Cmd+K toggles the palette from anywhere, the editor included (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        // P2-7: what is typed before the palette's field has focus goes to the field, not to the composer.
        if (paletteOpen.current) takeTypeahead();
        else holdTypeahead();
        setPalette(!paletteOpen.current);
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
  }, [paletteOpen]);

  const toggleSidebar = () => {
    if (!drawerMode) return setInlineOpen((o) => !o);
    // Remember the opener now: once the main column goes inert it loses focus.
    if (!drawerOpen) drawerOpener.current = document.activeElement as HTMLElement | null;
    setDrawerOpen((o) => !o);
  };
  const newProject = () => {
    setDrawerOpen(false);
    if (noProvider) navigate(null);
    else setCreating(true);
  };
  const openSettings = (section = "general") => {
    setDrawerOpen(false);
    window.location.hash = settingsHref(section);
  };
  const openPalette = () => {
    setDrawerOpen(false);
    setPalette(true);
  };

  // P2-3: unreachable before anything loaded takes the panel; after that a banner sits over the workspace, which stays.
  const offlineFull = health === "offline" && projects === null;
  const workspace = !offlineFull && known && route.projectId !== null;
  let main: React.ReactNode = null;
  if (offlineFull)
    main = (
      <Suspense fallback={null}>
        <OfflineState />
      </Suspense>
    );
  else if (routeState === "missing") main = <ProjectGone />;
  else if (noProvider && route.projectId === null)
    main = (
      <Suspense fallback={null}>
        <ConnectScreen />
      </Suspense>
    );
  else if (projects && projects.length === 0)
    main = (
      <Suspense fallback={null}>
        <NoProjectsHero onCreate={newProject} />
      </Suspense>
    );
  else if (route.projectId === null && projects)
    main = (
      <Suspense fallback={null}>
        <Home unseen={unseen} onNewProject={newProject} onSearch={openPalette} />
      </Suspense>
    );

  const drawerShown = drawerMode && drawerOpen;
  const tree =
    view === "projects" ? undefined : (
      <Suspense fallback={<SkeletonList count={3} size="lg" twoLine className="mt-4" />}>
        <SessionTree
          mode={view === "sessions" ? "sessions" : "tree"}
          activeProjectId={route.projectId}
          activeSessionId={route.sessionId}
          agentRoute={route.agentId !== null}
          unseen={unseen}
          canCreate={health === "online"}
          onNewProject={newProject}
          onPick={() => setDrawerOpen(false)}
        />
      </Suspense>
    );
  const sidebarProps = {
    activeProjectId: route.projectId,
    home: route.projectId === null && (projects?.length ?? 0) > 0,
    unseen,
    onNewProject: newProject,
    onSearch: openPalette,
    onReview: () => {
      setDrawerOpen(false);
      nav.workspace()?.openTool("review");
    },
    onSettings: () => openSettings(),
    // Picking a project closes the drawer even when it is the one already open (the route does not change then).
    onPick: () => setDrawerOpen(false),
    tree,
  };

  const actions: PaletteAction[] = [
    { id: "home", label: "Go to Home", run: () => navigate(null) },
    { id: "new", label: "New project", run: newProject },
    { id: "settings", label: "Open settings", run: () => openSettings() },
    { id: "integrations", label: "Open integrations", run: () => openSettings("integrations") },
    { id: "providers", label: "Connect a provider", run: () => openSettings("providers") },
    { id: "sidebar", label: "Toggle sidebar", run: toggleSidebar },
  ];

  return (
    <ShellContext.Provider value={{ sidebarOpen, toggleSidebar, openConnect }}>
      <StatusSlotsContext.Provider value={{ start: statusStart, end: statusEnd }}>
        <div className="relative flex h-full flex-col overflow-clip bg-window text-fg">
          {/* Decision 67: the top row is the window's, 40px across it: the controls float over its left corner and, with a project
            open, the tab strips of the dock groups are the row. Home and Settings have the bare row (and Settings its title). */}
          <TitleBar {...(settings !== null ? { title: "Settings" } : {})} />
          {settings !== null && (
            <div className="min-h-0 flex-1 pt-bar">
              <Suspense fallback={null}>
                <SettingsPage
                  section={settings}
                  onBack={() => (window.location.hash = beforeSettings.current)}
                  connect={setConnectTarget}
                  restart={host.restart}
                  projectId={openProject}
                />
              </Suspense>
            </div>
          )}
          <div className="flex min-h-0 flex-1" hidden={settings !== null}>
            {!drawerMode && inlineOpen && (
              <div className="flex h-full shrink-0 pt-bar">
                <Sidebar {...sidebarProps} />
              </div>
            )}
            {/* Equal gutters on the other sides of every panel (the sidebar card included); the row above is the top one. Full-bleed on phones. */}
            <div
              className={cn(
                "relative flex min-w-0 flex-1 flex-col p-gutter pt-0 pb-0 max-sm:p-0",
                !(workspace && route.projectId) && "pt-bar",
                !workspace && main === null && startsInProject && "max-sm:pt-bar",
              )}
              inert={drawerShown}
            >
              {workspace && route.projectId ? (
                <ProjectProvider key={route.projectId} projectId={route.projectId}>
                  {demo && window.location.hash.endsWith("/memory") ? (
                    <Suspense fallback={null}>
                      <MemoryRoute />
                    </Suspense>
                  ) : (
                    <ProjectWorkspace agentId={route.agentId} sessionId={route.sessionId} onLost={onProjectLost} />
                  )}
                </ProjectProvider>
              ) : (
                <Panel className="flex-1">
                  {/* Until the projects are in (or the route's project is found), lines instead of an empty card. */}
                  <div className="min-h-0 flex-1">{main ?? (!offlineFull && <MainSkeleton />)}</div>
                </Panel>
              )}
              {health !== "online" && projects !== null && (
                <Suspense fallback={null}>
                  <OfflineBanner />
                </Suspense>
              )}
            </div>
          </div>
          <StatusBar home={route.projectId === null && settings === null} startRef={setStatusStart} endRef={setStatusEnd} />
          <Presence show={drawerShown}>
            <Suspense fallback={null}>
              <SidebarDrawer onClose={() => setDrawerOpen(false)} opener={drawerOpener}>
                <Sidebar {...sidebarProps} />
              </SidebarDrawer>
            </Suspense>
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
          <Presence show={connectTarget !== null}>
            <Suspense fallback={null}>
              <ConnectSheet target={connectTarget ?? ""} onUseAnyway={useAnyway} onClose={() => setConnectTarget(null)} />
            </Suspense>
          </Presence>
          <Presence show={palette}>
            <Suspense fallback={null}>
              <CommandPalette
                openProjectId={known ? route.projectId : null}
                actions={actions}
                settingsIndex={loadSettingsIndex}
                onClose={() => {
                  takeTypeahead();
                  setPalette(false);
                }}
              />
            </Suspense>
          </Presence>
          <Suspense fallback={null}>
            <ShortcutsSheet />
          </Suspense>
          <Presence show={pending}>
            <Suspense fallback={null}>
              <LeaveDialog
                count={nav.unsavedCount()}
                onStay={() => {
                  nav.clearPendingTurn();
                  stay();
                }}
                onLeave={proceed}
              />
            </Suspense>
          </Presence>
        </div>
      </StatusSlotsContext.Provider>
    </ShellContext.Provider>
  );
}
