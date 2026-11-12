import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { navigate } from "../lib/route";
import { useApp } from "../state/app";
import { CodeProvider, useCode } from "../state/code";
import { CommentsProvider } from "../state/comments";
import { FileViewProvider } from "../state/fileView";
import { useShowFiles } from "../components/files/useShowFiles";
import { useProject } from "../state/project";
import { allTabs, fileTab, focusedGroup, parseTab } from "../state/workspace/layout";
import { useWorkspace, WorkspaceProvider } from "../state/workspace/WorkspaceProvider";
import { Dock } from "../components/dock/Dock";
import { Button } from "../components/primitives/Button";
import { Presence } from "../components/primitives/Presence";
import { ChatSlotsProvider, type ChatSlots } from "../state/chatSlots";
import { Panel } from "../components/shell/Panel";

/** The status bar's project items load after first paint (its own chunk; the row itself is always there, so nothing shifts). */
const ProjectStatus = lazy(() => import("../components/status/ProjectStatus").then((m) => ({ default: m.ProjectStatus })));

/** Keeps the project's command runs current for the top row, the run tabs and the status bar (decision 68). */
const ProjectRunsFeed = lazy(() => import("../components/commands/ProjectRunsFeed"));

/** The project dialog loads on first use (its own chunk). */
const CloseDialog = lazy(() => import("../components/shell/DiscardDialogs").then((m) => ({ default: m.CloseDialog })));
const ProjectDialog = lazy(() => import("../components/project/ProjectDialog").then((m) => ({ default: m.ProjectDialog })));

/** The v7 pieces the conversation and the composer show (approvals, forms, the harness queue); each renders nothing when the bridge lacks its methods. */
const ApprovalsSlot = lazy(() => import("../components/v7/ApprovalsSlot").then((m) => ({ default: m.ApprovalsSlot })));
const QueueSlot = lazy(() => import("../components/v7/QueueSlot").then((m) => ({ default: m.QueueSlot })));
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
export function ProjectWorkspace(props: { agentId: string | null }) {
  const [settings, setSettings] = useState(false);
  const openSettings = useCallback(() => setSettings(true), []);
  const { projectId } = useProject();
  return (
    // The file-view state sits above the workspace: the dock's width floors read each group's tree column (decision 94a).
    <FileViewProvider projectId={projectId}>
      <WorkspaceProvider routeAgentId={props.agentId} onSettings={openSettings}>
        <Files>
          <ChatSlotsProvider value={CHAT_SLOTS}>
            <Suspense fallback={null}>
              <ProjectStatus />
              <ProjectRunsFeed />
            </Suspense>
            <Body />
          </ChatSlotsProvider>
          <SettingsDialog show={settings} onClose={() => setSettings(false)} />
          <Suspense fallback={null}>
            <CloseDialog />
          </Suspense>
        </Files>
      </WorkspaceProvider>
    </FileViewProvider>
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
          <LoadError message={loadError} onRetry={reload} />
        </Panel>
      ) : (
        project && <Dock />
      )}
    </div>
  );
}

function SettingsDialog({ show, onClose }: { show: boolean; onClose(): void }) {
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
              await bridge.deleteProject(projectId);
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

function LoadError({ message, onRetry }: { message: string; onRetry(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="alert" className="mx-auto w-full max-w-measure px-6 pt-10 text-sm max-drawer:px-4">
      <p className="text-fg">Couldn't load this project.</p>
      <p className="mt-1 text-fg-2">{message.replace(/\.$/, "")}. Check that the harness bridge is running, then retry.</p>
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
