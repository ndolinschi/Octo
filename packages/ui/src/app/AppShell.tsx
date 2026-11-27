import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/cn";
import { loadPref, PREFS, sidebarViewCodec } from "../lib/storage";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { palette as paletteGate } from "../lib/typeahead";
import { visibleComposer } from "../lib/focus";
import { navigate, resolveProjectRoute, settingsHref, useGuardedRoute, useSettingsSection } from "../lib/route";
import { useRouteFocus } from "./routeFocus";
import { useProviders } from "../lib/providers/useProviders";
import { startupOpensLast, useStoredMotion } from "../components/settings/prefs";
import { useUnseen } from "../lib/seen";
import { useApp } from "../state/app";
import { useHost } from "../state/host";
import { NavProvider, useNav } from "../state/nav";
import { ProjectProvider } from "../state/project";
import { ShellContext } from "../state/shell";
import { useTabFlags } from "../state/tabFlags";
import { Presence } from "../components/primitives/Presence";
import type { PaletteAction } from "../components/shell/CommandPalette";
import { Panel } from "../components/shell/Panel";
import { MainSkeleton } from "../components/shell/MainSkeleton";
import { SkeletonList } from "../components/primitives/Skeleton";
import { Sidebar } from "../components/shell/Sidebar";
import { TitleBar } from "../components/shell/TitleBar";
import { StatusBar } from "../components/status/StatusBar";
import { StatusSlotsContext } from "../state/statusSlots";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ActivityProvider } from "../state/activity";
import { readyLazy } from "../lib/readyLazy";
import { registerWarm } from "../lib/warm";
import { DRAWER_QUERY } from "../lib/constants";
import { usePhone } from "../lib/phone";
import { useProjectSwitch } from "./useProjectSwitch";

/** Home loads on first visit (its own chunk); the app usually opens a project. */
/** The palette loads after the first paint (idle) or on first use, whichever comes first (its own chunk). */
/** The settings index for the palette's Settings group (loaded with the palette). */
const loadSettingsIndex = () => import("../components/settings/settingsIndex");
const palettePart = readyLazy(() => import("../components/shell/CommandPalette").then((m) => m.CommandPalette));
const CommandPalette = palettePart.Component;
registerWarm("palette", palettePart.fetch);
registerWarm("palette", loadSettingsIndex);
/** The shortcuts sheet: its own chunk, mounted for its "?" key; it renders only while open. */
const ShortcutsSheet = lazy(() => import("../components/shell/ShortcutsSheet"));
/** Native desktop notifications for background session completions / approvals (lazy chunk). */
const DesktopNotifier = lazy(() => import("../components/shell/DesktopNotifier"));
/** Demo-only `#/p/<id>/memory` (the Memory view on its own); not in a normal start's chunks. */
const MemoryRoute = lazy(() => import("./MemoryRoute").then((m) => ({ default: m.MemoryRoute })));
/** States the app is rarely in: their own chunks (bundle budget). */
const NoProjectsHero = lazy(() => import("../components/project/NoProjectsHero").then((m) => ({ default: m.NoProjectsHero })));
const ProjectGone = lazy(() => import("./ProjectWorkspaceStates").then((m) => ({ default: m.ProjectGone })));
// The same chunk as OfflineState: a chunk of its own would cost the entry more than the banner itself.
const OfflineBanner = lazy(() => import("../components/shell/OfflineState").then((m) => ({ default: m.OfflineBanner })));
const OfflineState = lazy(() => import("../components/shell/OfflineState").then((m) => ({ default: m.OfflineState })));
const Home = lazy(() => import("../components/home/Home").then((m) => ({ default: m.Home })));
/** The project dialog and the settings page load on first use, warmed on idle and on intent (their own chunks; v6.3 bundle). */
const projectDialogPart = readyLazy(() => import("./NewProjectDialog").then((m) => m.NewProjectDialog));
const NewProjectDialog = projectDialogPart.Component;
registerWarm("project-dialog", projectDialogPart.fetch);
const settingsPart = readyLazy(() => import("../components/settings/SettingsPage").then((m) => m.SettingsPage));
const SettingsPage = settingsPart.Component;
registerWarm("settings", settingsPart.fetch);
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
/** Decision 99: reads a project switched to out of sight (its own chunk, warmed after the first paint). */
const ProjectPreload = lazy(() => import("../state/projectPreload"));
/** Direction 7: the phone layout's frame (the top bar off a project, keyboard and touch helpers); its own chunk, only in that mode. */
const PhoneChrome = lazy(() => import("./phone/PhoneChrome"));

export function AppShell() {
  return (
    <NavProvider>
      <ActivityProvider>
        <Shell />
      </ActivityProvider>
    </NavProvider>
  );
}

function Shell() {
  const { health, projects, bridge, refreshProjects, demo } = useApp();
  const host = useHost();
  const nav = useNav();
  const tabFlags = useTabFlags();
  // Leaving a project with unsaved editor changes asks first.
  const { route, pending, proceed, stay } = useGuardedRoute(
    (next, current) => current.projectId !== null && next.projectId !== current.projectId && nav.unsavedCount() > 0,
  );
  const phone = usePhone();
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
  const noProvider =
    providers.status === "ready" && (providers.list.connected === 0 || !providers.list.providers.some((p) => p.kind !== "ollama" && p.state === "ready"));
  useStoredMotion();
  // NEW-7: the palette's phase and number (`lib/typeahead`): each open is a new palette, so one reopened while the last one
  // still plays its exit mounts fresh (its field takes focus and the keys held for it).
  const paletteState = useSyncExternalStore(paletteGate.subscribe, paletteGate.snapshot);
  const palette = paletteState.phase === "opening" || paletteState.phase === "open";
  const drawerOpener = useRef<HTMLElement | null>(null);
  useRouteFocus(settings !== null);
  // The two ends of the status bar that the open project fills (see `ProjectStatus`).
  const [statusStart, setStatusStart] = useState<HTMLElement | null>(null);
  const [statusEnd, setStatusEnd] = useState<HTMLElement | null>(null);
  const sidebarOpen = drawerMode ? drawerOpen : inlineOpen;

  // P1-4: the route alone says which project is shown and sent to. An id the list lacks is looked up (list and project)
  // instead of falling back to another project; a 404 makes it "missing", even while a stale list still has it.
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const routeState = resolveProjectRoute(route.projectId, projects, missing);
  const known = routeState === "show";
  // Decision 99: what the main area shows lags the route while a project switched to is read out of sight.
  const { shown, preload, loading, onLate, onShow } = useProjectSwitch(route, bridge, known);
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
    if (shown.projectId !== null) void lookUp(shown.projectId);
  }, [shown.projectId, lookUp]);
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

  // Warming after the first paint (`app/warmApp`, its own chunk): the chunks the first minutes need (Markdown, the transcript,
  // tool lines…), then the lazy surfaces on intent and on idle. A failed load of that chunk only means nothing is warmed: every
  // surface still loads on first open.
  useEffect(() => {
    let stop: () => void = () => undefined;
    let live = true;
    void import("./warmApp").then(
      (m) => {
        if (live) stop = m.startWarming(document);
      },
      () => undefined,
    );
    return () => {
      live = false;
      stop();
    };
  }, []);

  // NEW-6: Back / Forward (or any hash change) closes the transient overlays that are not the new route's own: the palette and
  // the New project dialog (its draft is kept). The shortcuts sheet closes itself the same way.
  useEffect(() => {
    const close = () => {
      paletteGate.close();
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
        paletteGate.toggle();
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        paletteGate.toggle();
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        paletteGate.toggleFiles();
      }
      // Ctrl/Cmd+L: the caret into the visible composer, from anywhere (Monaco handles its own Mod+L to attach the selection first).
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "l" &&
        !document.querySelector('[aria-modal="true"]') &&
        !(e.target instanceof Element && e.target.closest("[data-editor-chat]"))
      ) {
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
    // Decision 2026-11-15: a project is a folder and settings; it is never held back for a provider (the dialog says what is not ready).
    setCreating(true);
  };
  const openSettings = (section = "general") => {
    setDrawerOpen(false);
    window.location.hash = settingsHref(section);
  };
  const openPalette = () => {
    setDrawerOpen(false);
    paletteGate.open();
  };

  // P2-3: unreachable before anything loaded takes the panel; after that a banner sits over the workspace, which stays.
  const offlineFull = health === "offline" && projects === null;
  // While a switch holds, `known` is the next project's (the hold needs it) and the previous one is shown.
  const workspace = !offlineFull && !loading && known && shown.projectId !== null;
  let main: React.ReactNode = null;
  if (offlineFull)
    main = (
      <Suspense fallback={null}>
        <OfflineState />
      </Suspense>
    );
  else if (routeState === "missing")
    main = (
      <Suspense fallback={null}>
        <ProjectGone />
      </Suspense>
    );
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
  else if (shown.projectId === null && projects && !loading)
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
    showReview: tabFlags.review,
    onReview: () => {
      setDrawerOpen(false);
      nav.workspace()?.openTool("review");
    },
    // Direction 7: the phone opens the list of sections (`#/settings/`), the desktop its first section.
    onSettings: () => openSettings(phone ? "" : undefined),
    // Picking a project closes the drawer even when it is the one already open (the route does not change then).
    onPick: () => setDrawerOpen(false),
    tree,
  };

  const actions = useMemo<PaletteAction[]>(
    () => [
      { id: "home", label: "Go to Home", run: () => navigate(null) },
      { id: "new", label: "New project", run: newProject },
      { id: "settings", label: "Open settings", run: () => openSettings() },
      { id: "integrations", label: "Open integrations", run: () => openSettings("integrations") },
      { id: "providers", label: "Connect a provider", run: () => openSettings("providers") },
      { id: "sidebar", label: "Toggle sidebar", run: toggleSidebar },
    ],
    // Stable handlers derived from setters/refs within Shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerMode, drawerOpen],
  );
  const shellValue = useMemo(() => ({ sidebarOpen, toggleSidebar, openConnect }), [sidebarOpen, drawerMode, drawerOpen]);
  const statusSlotsValue = useMemo(() => ({ start: statusStart, end: statusEnd }), [statusStart, statusEnd]);

  return (
    <ShellContext.Provider value={shellValue}>
      <StatusSlotsContext.Provider value={statusSlotsValue}>
        <div data-app-root data-offline={health === "offline" || undefined} className="relative flex h-full flex-col overflow-clip bg-window text-fg">
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
            <main
              className={cn(
                "relative flex min-w-0 flex-1 flex-col p-gutter pt-0 pb-0 max-sm:p-0 phone:px-0",
                // Direction 7: the phone's window header lies over the panel's top (Home, the connect screen, the no-projects hero):
                // their content and the streak band start under it, as Settings' do (decision 91a: nothing sits on the band).
                !(workspace && shown.projectId) && "pt-bar phone:pt-bar",
                !workspace && main === null && startsInProject && "max-sm:pt-bar phone:pt-bar",
              )}
              inert={drawerShown}
            >
              {preload && (
                <Suspense fallback={null}>
                  <ProjectPreload key={preload.projectId} target={preload} onLate={onLate} onShow={onShow} />
                </Suspense>
              )}
              {workspace && shown.projectId ? (
                <ProjectProvider key={shown.projectId} projectId={shown.projectId}>
                  {demo && tabFlags.memory && window.location.hash.endsWith("/memory") ? (
                    <Suspense fallback={null}>
                      <MemoryRoute />
                    </Suspense>
                  ) : (
                    <ProjectWorkspace agentId={shown.agentId} sessionId={shown.sessionId} onLost={onProjectLost} />
                  )}
                </ProjectProvider>
              ) : (
                <Panel className="flex-1" data-switching={loading}>
                  {/* Until the projects are in (or the route's project is found), lines instead of an empty card. */}
                  <div className="min-h-0 flex-1">{main ?? (!offlineFull && <MainSkeleton />)}</div>
                </Panel>
              )}
              {health !== "online" && projects !== null && (
                <Suspense fallback={null}>
                  <OfflineBanner />
                </Suspense>
              )}
            </main>
          </div>
          <StatusBar home={shown.projectId === null && settings === null} startRef={setStatusStart} endRef={setStatusEnd} />
          {phone && (
            <Suspense fallback={null}>
              <PhoneChrome projectShown={workspace && shown.projectId !== null} />
            </Suspense>
          )}
          <Presence show={drawerShown}>
            <Suspense fallback={null}>
              <SidebarDrawer onClose={() => setDrawerOpen(false)} opener={drawerOpener}>
                <Sidebar {...sidebarProps} />
              </SidebarDrawer>
            </Suspense>
          </Presence>
          <Presence show={creating}>
            <Suspense fallback={null}>
              <NewProjectDialog onClose={() => setCreating(false)} />
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
                key={paletteState.id}
                paletteId={paletteState.id}
                initialMode={paletteState.mode ?? "all"}
                openProjectId={known ? route.projectId : null}
                actions={actions}
                settingsIndex={loadSettingsIndex}
                onClose={() => paletteGate.close(paletteState.id)}
              />
            </Suspense>
          </Presence>
          <Suspense fallback={null}>
            <ShortcutsSheet />
            <DesktopNotifier />
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
