import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { sessionTitle } from "../lib/sessions/title";
import { usePhone } from "../lib/phone";
import { windowTitle } from "../lib/statusBar";
import { CodeProvider, useCode } from "../state/code";
import { CommentsProvider } from "../state/comments";
import { FileViewProvider } from "../state/fileView";
import { useShowFiles } from "../components/files/useShowFiles";
import { useProject } from "../state/project";
import { allTabs, fileTab, focusedGroup, parseTab } from "../state/workspace/layout";
import { useWorkspace, WorkspaceProvider } from "../state/workspace/WorkspaceProvider";
import { Dock } from "../components/dock/Dock";
import { ChatSlotsProvider, type ChatSlots } from "../state/chatSlots";
import { Panel } from "../components/shell/Panel";
import { MainSkeleton } from "../components/shell/MainSkeleton";
import { readyLazy } from "../lib/readyLazy";

/** The status bar's project items load after first paint (its own chunk; the row itself is always there, so nothing shifts). */
const ProjectStatus = lazy(() => import("../components/status/ProjectStatus").then((m) => ({ default: m.ProjectStatus })));

/** Direction 7: the phone layout's one-line header in place of the tab strips (its own chunk, only in that mode). */
const PhoneHeader = lazy(() => import("../components/dock/phone/PhoneHeader"));

/** Keeps the project's command runs current for the top row, the run tabs and the status bar (decision 68). */
const ProjectRunsFeed = lazy(() => import("../components/commands/ProjectRunsFeed"));

/** The project dialog and error screen load on first use (their own chunks). */
const CloseDialog = lazy(() => import("../components/shell/DiscardDialogs").then((m) => ({ default: m.CloseDialog })));
const SettingsDialog = lazy(() => import("./ProjectSettingsDialog"));
const LoadError = lazy(() => import("./ProjectWorkspaceStates").then((m) => ({ default: m.LoadError })));

/** The v7 pieces the conversation and the composer show (approvals, forms, the harness queue); each renders nothing when the bridge lacks its methods. */
/** Decision 99: they render without suspending once in (`warmApp` fetches them), so a project shown first paints with them. */
export const approvalsPart = readyLazy(() => import("../components/v7/ApprovalsSlot").then((m) => m.ApprovalsSlot));
export const queuePart = readyLazy(() => import("../components/v7/QueueSlot").then((m) => m.QueueSlot));
const ApprovalsSlot = approvalsPart.Component;
const QueueSlot = queuePart.Component;
const QueueBadge = lazy(() => import("../components/v7/QueueList").then((m) => ({ default: m.QueueBadge })));
const CHAT_SLOTS: ChatSlots = {
  approvals: ({ onOpenAgent }) => (
    <Suspense fallback={null}>
      <ApprovalsSlot onOpenAgent={onOpenAgent} />
    </Suspense>
  ),
  queue: ({ onCount }) => (
    <Suspense fallback={null}>
      <QueueSlot onCount={onCount} />
    </Suspense>
  ),
  badge: (count) =>
    count > 0 ? (
      <Suspense fallback={null}>
        <QueueBadge count={count} />
      </Suspense>
    ) : null,
};

/** One project: header row, then the dock of tab groups. */
export function ProjectWorkspace(props: { agentId: string | null; sessionId?: string | null; onLost(): void }) {
  // Null until first opened: the dialog's chunk loads then (and stays for its exit).
  const [settings, setSettings] = useState<boolean | null>(null);
  const phone = usePhone();
  const openSettings = useCallback(() => setSettings(true), []);
  const { projectId, live, loadError, project } = useProject();
  // P1-4: a stream that drops or a load that fails may mean the project was deleted elsewhere: the shell looks it up.
  const lost = live === "reconnecting" || (loadError !== null && project === null);
  const { onLost } = props;
  useEffect(() => {
    if (lost) onLost();
  }, [lost, onLost]);
  return (
    // The file-view state sits above the workspace: the dock's width floors read each group's tree column (decision 94a).
    <FileViewProvider projectId={projectId}>
      <WorkspaceProvider routeAgentId={props.agentId} routeSessionId={props.sessionId ?? null} onSettings={openSettings}>
        <Files>
          <ChatSlotsProvider value={CHAT_SLOTS}>
            <Suspense fallback={null}>
              <ProjectStatus />
              <ProjectRunsFeed />
            </Suspense>
            {phone && (
              <Suspense fallback={null}>
                <PhoneHeader />
              </Suspense>
            )}
            <WorkspaceTitle phone={phone} />
            <Body />
          </ChatSlotsProvider>
          {settings !== null && (
            <Suspense fallback={null}>
              <SettingsDialog show={settings} onClose={() => setSettings(false)} />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <CloseDialog />
          </Suspense>
        </Files>
      </WorkspaceProvider>
    </FileViewProvider>
  );
}

/**
 * 11d: the screen's name, "<Project> — <session>": the window title ("… · Octo") and, on the desktop, the page's h1 for a
 * screen reader (the phone header has its own visible h1). The h1 takes focus after a route change that left it nowhere.
 */
function WorkspaceTitle({ phone }: { phone: boolean }) {
  const ws = useWorkspace();
  const { project, state } = useProject();
  const sid = ws.focusedSessionId ?? state.sessions.defaultId ?? null;
  const session = sid !== null ? state.sessions.list.find((x) => x.id === sid) : undefined;
  const title = project ? (session ? `${project.name} — ${sessionTitle(session)}` : project.name) : "";
  const needsYou = state.attention.needs_you;
  useEffect(() => {
    if (!title) return;
    document.title = windowTitle(title, needsYou);
  }, [title, needsYou]);
  if (phone || !title) return null;
  return (
    <h1 data-page-title tabIndex={-1} className="sr-only">
      {title}
    </h1>
  );
}

/** Open files live under the workspace; it opens their tabs and they report back. */
function Files({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const files = useShowFiles();
  return (
    <CodeProvider onOpen={(key, where) => ws.openFileTab(key, where)} onReveal={files.show} onGone={(key) => ws.dropTab(fileTab(key))}>
      <CodeLink />
      <CommentsProvider>{children}</CommentsProvider>
    </CodeProvider>
  );
}

/** Wires the open-files state into the workspace: close guards, restoring file tabs, tree selection. */
function CodeLink() {
  const ws = useWorkspace();
  const code = useCode();
  const { project } = useProject();
  useLayoutEffect(() => {
    ws.attachCode({
      modified: (key) => code.file(key)?.modified ?? false,
      name: (key) => code.file(key)?.name ?? key,
      close: code.close,
      restore: code.restore,
      select: code.select,
      openFile: (folder, path, line) => code.openFile(folder, path, line ? { line, column: 1 } : undefined),
    });
    return () => ws.attachCode(null);
  });

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !project) return;
    restored.current = true;
    for (const tab of allTabs(ws.layout)) {
      const ref = parseTab(tab);
      if (ref?.kind === "file") code.restore(ref.key);
    }
  }, [project, ws.layout, code]);

  const active = focusedGroup(ws.layout).active;
  const { select } = code;
  useEffect(() => {
    const ref = parseTab(active);
    if (ref?.kind === "file") select(ref.key);
  }, [active, select]);
  return null;
}

/** The dock of tab groups; tools open from each strip's "+" (`TabPicker`), the palette and the orchestrator header's `…` menu. */
function Body() {
  const { project, loadError, reload } = useProject();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {loadError && !project ? (
        <Panel className="mt-bar flex-1">
          <Suspense fallback={null}>
            <LoadError message={loadError} onRetry={reload} />
          </Suspense>
        </Panel>
      ) : project ? (
        <Dock />
      ) : (
        <Panel className="mt-bar flex-1">
          <MainSkeleton />
        </Panel>
      )}
    </div>
  );
}
