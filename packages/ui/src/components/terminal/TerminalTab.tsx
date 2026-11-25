import "@xterm/xterm/css/xterm.css";
import { Eraser, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { mayChangeProject, ON_YOUR_COMPUTER } from "../../lib/remoteDevice";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { onTerminalCommand, takeTerminalCommand } from "../../state/terminalRun";
import { domId } from "../../state/workspace/ids";
import type { TabId } from "../../state/workspace/layout";
import { MOD, useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import type { MenuItem } from "../primitives/Menu";
import { MenuButton } from "../primitives/MenuButton";
import { Notice } from "../primitives/Notice";
import { Panel, PanelEmpty } from "../primitives/Panel";
import { StateGlyph } from "../primitives/StateGlyph";
import { PanelPurpose } from "../shared/PanelPurpose";
import { getManagedTerminal, type TerminalStatus } from "./sessionStore";
import { useTerminalSurface } from "./useTerminalSurface";

const STATUS_WORD: Record<TerminalStatus, string> = { connecting: "Connecting", running: "Running", exited: "Exited", error: "Not running" };

export default function TerminalTab(props: { tab: TabId; terminalId: string }) {
  const { bridge } = useApp();
  const { remoteDevice } = useHost();
  const { project, projectId } = useProject();
  const ws = useOptionalWorkspace();
  const canRunLocal = mayChangeProject(remoteDevice);

  const folders = useMemo(() => project?.folders ?? [], [project?.folders]);
  const defaultFolder = folders[0]?.label ?? "";

  const entry = useMemo(() => getManagedTerminal(projectId, props.terminalId, defaultFolder), [projectId, props.terminalId, defaultFolder]);
  const snap = useSyncExternalStore(entry.subscribe, entry.snapshot);

  const hostRef = useRef<HTMLDivElement>(null);
  const ready = canRunLocal && !!bridge.openTerminal && folders.length > 0;
  const termRef = useTerminalSurface({ hostRef, entry, bridge, enabled: ready, defaultFolder });
  const visible = ws ? ws.isVisible(props.tab) : true;

  // Run commands queued from Markdown shell code blocks once this visible terminal's shell is running.
  useEffect(() => {
    if (!ready || !visible || snap.status !== "running") return;
    const flush = () => {
      const cmd = takeTerminalCommand();
      if (!cmd) return;
      entry.write(`${cmd}\n`);
      termRef.current?.focus();
    };
    flush();
    return onTerminalCommand(flush);
  }, [ready, visible, snap.status, entry, termRef]);

  const restart = useCallback(
    (nextFolder?: string) => {
      const term = termRef.current;
      if (term) {
        term.reset();
        entry.clearHistory();
      }
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      entry.start(bridge, cols, rows, nextFolder ?? (snap.folder || defaultFolder));
      term?.focus();
    },
    [bridge, defaultFolder, entry, snap.folder, termRef],
  );

  const clearScreen = useCallback(() => {
    entry.clearHistory();
    termRef.current?.clear();
    termRef.current?.focus();
  }, [entry, termRef]);

  const activeFolder = snap.folder || defaultFolder;
  const folderItems: MenuItem[] = folders.map((f) => ({
    id: f.label,
    label: f.label,
    checked: f.label === activeFolder,
    run: () => {
      if (f.label !== activeFolder) restart(f.label);
    },
  }));
  const statusTip = `${STATUS_WORD[snap.status]}${snap.pid > 0 && snap.status === "running" ? ` · PID ${snap.pid}` : ""}`;

  return (
    <div
      id={`${domId(props.tab)}-panel`}
      data-terminal-tab
      tabIndex={-1}
      onMouseDown={(e) => {
        if (ready && e.target === e.currentTarget) termRef.current?.focus();
      }}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      <Panel
        name="terminal"
        title="Terminal"
        lead={
          <>
            <PanelPurpose tool="terminal" />
            {ready && (
              <div className="flex min-w-0 items-center gap-2">
                {/* Work-surface polish item 10: the PID lives in the status glyph's tooltip, not in the bar. */}
                <span role="img" aria-label={statusTip} title={statusTip} className="grid size-4 shrink-0 place-items-center">
                  {snap.status === "running" ? (
                    <span className="size-2 rounded-full bg-ok" />
                  ) : (
                    <StateGlyph state={snap.status === "connecting" ? "working" : snap.status === "error" ? "failed" : "stopped"} />
                  )}
                </span>
                <span className="font-mono text-xs font-medium text-fg">{snap.shell || "shell"}</span>
                {folders.length > 1 ? (
                  <MenuButton label="Working folder" text={activeFolder} items={folderItems} />
                ) : (
                  <span className="truncate font-mono text-xs text-fg-2">{activeFolder}</span>
                )}
              </div>
            )}
          </>
        }
        actions={
          ready ? (
            <>
              <IconButton icon={Eraser} label="Clear terminal" size="sm" onClick={clearScreen} />
              <IconButton icon={RotateCw} label="Restart terminal" size="sm" onClick={() => restart()} />
              {ws !== null && (
                <IconButton
                  icon={Plus}
                  label="New terminal tab"
                  size="sm"
                  shortcut={`${MOD}⇧\``}
                  onClick={() => ws.openTerminal({ newTab: true, folder: activeFolder })}
                />
              )}
            </>
          ) : undefined
        }
        notice={
          ready && (snap.error !== null || snap.status === "exited") ? (
            <Notice
              tone={snap.error !== null ? "error" : "info"}
              action={
                <Button variant="secondary" size="sm" onClick={() => restart()}>
                  Restart
                </Button>
              }
            >
              {snap.error ?? `Process exited (code ${snap.exitCode ?? 0}). Press Enter or Restart to open a new shell.`}
            </Notice>
          ) : undefined
        }
      >
        {!canRunLocal ? (
          <PanelEmpty title="Terminal runs on your computer">{ON_YOUR_COMPUTER}</PanelEmpty>
        ) : !bridge.openTerminal ? (
          <PanelEmpty title="Terminal unavailable">Update Octo&apos;s local service to open interactive terminals.</PanelEmpty>
        ) : folders.length === 0 ? (
          <PanelEmpty
            title="No project folder"
            actions={
              ws ? (
                <Button variant="secondary" size="sm" onClick={ws.openSettings}>
                  Project settings
                </Button>
              ) : undefined
            }
          >
            Add a folder to this project to open an interactive shell in it.
          </PanelEmpty>
        ) : (
          <div data-terminal-screen onClick={() => termRef.current?.focus()} className="min-h-0 flex-1 overflow-hidden p-2">
            <div ref={hostRef} data-audit-ignore className="h-full w-full" />
          </div>
        )}
      </Panel>
    </div>
  );
}
