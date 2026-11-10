import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { Dialog } from "../components/primitives/Dialog";
import { Presence } from "../components/primitives/Presence";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { Panel } from "../components/shell/Panel";
import { PanelBar } from "../components/shell/SidebarToggle";

/** One project: header row, then the dock of tab groups. */
export function ProjectWorkspace(props: { agentId: string | null }) {
  const [settings, setSettings] = useState(false);
  const openSettings = useCallback(() => setSettings(true), []);
  const { projectId } = useProject();
  return (
    <WorkspaceProvider routeAgentId={props.agentId} onSettings={openSettings}>
      <FileViewProvider projectId={projectId}>
        <Files>
          <Body />
          <SettingsDialog show={settings} onClose={() => setSettings(false)} />
          <CloseDialog />
        </Files>
      </FileViewProvider>
    </WorkspaceProvider>
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

/** The dock of tab groups; the project's global actions live in the strips (see `WorkspaceActions`). */
function Body() {
  const { project, loadError, reload } = useProject();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {loadError && !project ? (
        <Panel className="flex-1">
          <PanelBar />
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
      )}
    </Presence>
  );
}

/** Closing tabs with unsaved edits asks first. */
function CloseDialog() {
  const ws = useWorkspace();
  const closing = ws.closing;
  const many = (closing?.files.length ?? 0) > 1;
  return (
    <Presence show={closing !== null}>
      {closing && (
        <Dialog
          width="sm"
          title={many ? `Discard changes to ${closing.files.length}\u00a0files?` : `Discard changes to ${closing.files[0] ?? "this file"}?`}
          description={many ? `${closing.files.join(", ")} have unsaved edits that will be lost.` : "Your edits haven't been saved and will be lost."}
          onClose={ws.cancelClose}
          footer={
            <>
              <Button onClick={ws.cancelClose} data-autofocus>
                Cancel
              </Button>
              <Button variant="danger" onClick={ws.confirmClose}>
                Discard changes
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
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
