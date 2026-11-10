import { FolderTree, NotebookText, Workflow } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { cn } from "../lib/cn";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { navigate } from "../lib/route";
import { readPref, writePref } from "../lib/storage";
import { useApp } from "../state/app";
import { CodeProvider, useCode } from "../state/code";
import { useNav } from "../state/nav";
import { PaneProvider, type PanelTab } from "../state/pane";
import { useProject } from "../state/project";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { FilesPanel } from "../components/files/FilesPanel";
import { ConversationView } from "../components/chat/ConversationView";
import { NotesPanel } from "../components/notes/NotesPanel";
import { Button } from "../components/primitives/Button";
import { Tabs } from "../components/primitives/Tabs";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { ProjectHeader } from "../components/project/ProjectHeader";
import { Panel, panelClass } from "../components/shell/Panel";

/** At this width the side panel sits beside the conversation; below it, it overlays it. */
const DOCK_QUERY = "(min-width: 1100px)";

/** Docked pane width limits; the conversation keeps at least MIN_MAIN. */
const PANE_MIN = 280;
const PANE_DEFAULT = 320;
const MIN_MAIN = 400;
const SIDEBAR = 260;
/** Window margin and gap around the inset panels (6px each). */
const GUTTERS = 12;

function savedTab(): PanelTab {
  const v = readPref("panel");
  return v === "notes" || v === "files" ? v : "agents";
}

function savedWidth(): number | null {
  const n = Number(readPref("paneWidth"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** Opens by default only where it has room (docked) and the user hasn't closed it there. */
function initiallyOpen(): boolean {
  return window.matchMedia(DOCK_QUERY).matches && readPref("panel") !== "none";
}

export function ProjectWorkspace(props: {
  agentId: string | null;
  sidebarOpen: boolean;
  sidebarIsDrawer: boolean;
  onToggleSidebar(): void;
}) {
  const { bridge, refreshProjects, projects } = useApp();
  const nav = useNav();
  const { project, loadError, update, projectId, reload } = useProject();
  const docked = useMediaQuery(DOCK_QUERY);
  const [paneOpen, setPaneOpen] = useState(initiallyOpen);
  const [tab, setTabState] = useState<PanelTab>(savedTab);
  const [settings, setSettings] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const paneToggle = useRef<HTMLButtonElement>(null);
  const overlay = paneOpen && !docked;

  const remember = (open: boolean, next: PanelTab) => {
    if (docked) writePref("panel", open ? next : "none");
  };
  const setTab = (next: PanelTab) => {
    setTabState(next);
    remember(true, next);
  };
  const closePane = () => {
    setPaneOpen(false);
    remember(false, tab);
    if (!docked) paneToggle.current?.focus();
  };
  const togglePane = () => {
    if (paneOpen) return closePane();
    setPaneOpen(true);
    remember(true, tab);
  };
  const openPane = (next: PanelTab) => {
    setPaneOpen(true);
    setTabState(next);
    remember(true, next);
  };

  // The command palette toggles the pane through the shell.
  const toggleRef = useRef(togglePane);
  useLayoutEffect(() => {
    toggleRef.current = togglePane;
  });
  useEffect(() => {
    nav.setPaneToggle(() => toggleRef.current());
    return () => nav.setPaneToggle(null);
  }, [nav]);

  // An overlay pane takes focus when it opens; Esc or navigation closes it.
  useEffect(() => {
    if (overlay) pane.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [overlay]);
  useEscape(overlay, closePane);
  useEffect(() => {
    if (!docked) setPaneOpen(false);
  }, [docked, props.agentId]);

  const toggleSidebar = () => {
    // Never show the sidebar drawer and the pane overlay together.
    if (props.sidebarIsDrawer && !props.sidebarOpen) setPaneOpen(false);
    props.onToggleSidebar();
  };

  const header = (
    <ProjectHeader
      ref={paneToggle}
      sidebarOpen={props.sidebarOpen}
      onToggleSidebar={toggleSidebar}
      paneOpen={paneOpen}
      onTogglePane={togglePane}
      onSettings={() => setSettings(true)}
    />
  );

  if (loadError && !project) {
    return (
      <Panel className="h-full">
        {header}
        <LoadError message={loadError} onRetry={reload} />
      </Panel>
    );
  }

  const agentId = props.agentId ?? project?.orchestrator_agent_id ?? null;

  const paneBody = agentId && (
    <SidePane
      paneRef={pane}
      overlay={overlay}
      tab={tab}
      onTab={setTab}
      agentId={agentId}
      sidebarWidth={props.sidebarOpen && !props.sidebarIsDrawer ? SIDEBAR : 0}
      onSettings={() => setSettings(true)}
    />
  );

  return (
    <PaneProvider value={{ openPane, shown: paneOpen ? tab : null }}>
    <CodeProvider onReveal={() => openPane("files")}>
    <div className="flex h-full min-w-0 gap-1.5">
      <Panel className="flex-1">
        {header}
        <div className="relative flex min-h-0 flex-1">
          <main className="min-w-0 flex-1" aria-label="Conversation">
            {agentId && <ConversationView key={agentId} agentId={agentId} />}
          </main>
          {overlay && paneBody}
        </div>
      </Panel>
      {paneOpen && docked && paneBody}
      {settings && project && (
        <ProjectDialog
          project={project}
          onClose={() => setSettings(false)}
          onSubmit={async (input) => {
            await update(input);
            setSettings(false);
          }}
          onDelete={async () => {
            await bridge.deleteProject(projectId);
            setSettings(false);
            const next = projects?.find((p) => p.id !== projectId);
            navigate(next?.id ?? null);
            await refreshProjects();
          }}
        />
      )}
    </div>
    </CodeProvider>
    </PaneProvider>
  );
}

function SidePane(props: {
  paneRef: RefObject<HTMLElement | null>;
  overlay: boolean;
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  agentId: string;
  sidebarWidth: number;
  onSettings(): void;
}) {
  const { overlay, tab } = props;
  const hasFiles = useCode().files.length > 0;
  const windowWidth = useWindowWidth();
  const [userWidth, setUserWidth] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  const max = Math.max(PANE_MIN, windowWidth - props.sidebarWidth - GUTTERS - MIN_MAIN);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(PANE_MIN, w)));
  // With a file open the pane defaults to about half the window, until the user picks a width.
  const width = clamp(userWidth ?? (hasFiles && tab === "files" ? windowWidth / 2 : PANE_DEFAULT));
  const wide = hasFiles && tab === "files";

  const commit = (w: number | null) => {
    setUserWidth(w);
    writePref("paneWidth", w === null ? "" : String(w));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const start = width;
    let latest = width;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const body = document.body.style;
    body.cursor = "col-resize";
    body.userSelect = "none";
    const move = (ev: globalThis.PointerEvent) => {
      latest = clamp(start + startX - ev.clientX);
      setUserWidth(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      body.cursor = "";
      body.userSelect = "";
      setDragging(false);
      commit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const keys: Record<string, () => number> = {
      ArrowLeft: () => width + step,
      ArrowRight: () => width - step,
      Home: () => PANE_MIN,
      End: () => max,
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    commit(clamp(fn()));
  };

  const separator = !overlay && (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuemin={PANE_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commit(null)}
      className="group absolute inset-y-0 -left-1.5 z-30 w-1.5 cursor-col-resize rounded-xs outline-none focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-2 left-[2px] w-[2px] rounded-full transition-[background-color] duration-100 group-hover:bg-line-strong group-focus-visible:bg-focus group-data-[dragging]:bg-focus"
      />
    </div>
  );

  return (
    <aside
      ref={props.paneRef}
      aria-label="Side panel"
      style={overlay ? (wide ? { width: "min(100%, 640px)" } : undefined) : { width }}
      className={cn(
        "relative flex max-w-full shrink-0 flex-col",
        overlay ? "absolute inset-y-0 right-0 z-20 border-l border-line bg-panel shadow-pop" : "h-full",
        overlay && !wide && "w-pane",
      )}
    >
      {separator}
      <div className={cn("flex min-h-0 flex-1 flex-col", !overlay && cn(panelClass, "h-full"))}>
        <div className="flex h-10 shrink-0 items-center px-2">
          <Tabs<PanelTab>
            label="Side panel"
            idPrefix="panel"
            value={tab}
            onChange={props.onTab}
            options={[
              { value: "agents", label: "Agents", icon: Workflow },
              { value: "notes", label: "Notes", icon: NotebookText },
              { value: "files", label: "Files", icon: FolderTree },
            ]}
          />
        </div>
        <div role="tabpanel" id={`panel-panel-${tab}`} aria-labelledby={`panel-tab-${tab}`} className="min-h-0 flex-1">
          {tab === "agents" ? (
            <AgentsPanel currentAgentId={props.agentId} />
          ) : tab === "notes" ? (
            <NotesPanel />
          ) : (
            <FilesPanel onSettings={props.onSettings} />
          )}
        </div>
      </div>
    </aside>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="alert" className="mx-auto w-full max-w-measure px-6 pt-10 text-sm max-[1000px]:px-4">
      <p className="text-fg">Couldn't load this project.</p>
      <p className="mt-1 text-fg-2">
        {message.replace(/\.$/, "")}. Check that the harness bridge is running, then retry.
      </p>
      <Button
        size="sm"
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRetry();
          setBusy(false);
        }}
      >
        {busy ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
