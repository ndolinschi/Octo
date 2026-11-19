import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Eraser, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { monoFont } from "../../lib/monoFont";
import { mayChangeProject, ON_YOUR_COMPUTER } from "../../lib/remoteDevice";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { domId } from "../../state/workspace/ids";
import type { TabId } from "../../state/workspace/layout";
import { MOD, useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { IconButton } from "../primitives/IconButton";
import type { MenuItem } from "../primitives/Menu";
import { MenuButton } from "../primitives/MenuButton";
import { getManagedTerminal, type TerminalStatus } from "./sessionStore";
import { readXtermTheme } from "./xtermTheme";

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
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
    [bridge, defaultFolder, entry, snap.folder],
  );

  const clearScreen = useCallback(() => {
    entry.clearHistory();
    termRef.current?.clear();
    termRef.current?.focus();
  }, [entry]);

  useEffect(() => {
    if (!canRunLocal || !bridge.openTerminal || folders.length === 0) return;
    const container = hostRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: monoFont(),
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      convertEol: false,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    try {
      fit.fit();
    } catch {
      // Container may have 0x0 size before layout settles; ResizeObserver will fit next frame.
    }

    for (const chunk of entry.history()) {
      term.write(chunk);
    }

    const unsubOutput = entry.onOutput((chunk) => {
      term.write(chunk);
    });

    entry.start(bridge, term.cols || 80, term.rows || 24);

    const dataSub = term.onData((data) => {
      const cur = entry.snapshot();
      if (cur.status === "exited" && (data === "\r" || data === "\n")) {
        term.reset();
        entry.clearHistory();
        entry.start(bridge, term.cols || 80, term.rows || 24, cur.folder || defaultFolder);
        return;
      }
      entry.write(data);
    });

    let raf = 0;
    const syncSize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!container.isConnected || container.clientWidth < 24 || container.clientHeight < 24) return;
        try {
          fit.fit();
          entry.resize(term.cols, term.rows);
        } catch {
          // Ignore transient fit errors while hidden.
        }
      });
    };

    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    const mo = new MutationObserver(() => {
      term.options.theme = readXtermTheme();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

    const focusTimer = window.setTimeout(() => {
      if (container.offsetParent !== null) term.focus();
    }, 40);

    return () => {
      window.clearTimeout(focusTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      dataSub.dispose();
      unsubOutput();
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [bridge, canRunLocal, defaultFolder, entry, folders.length]);

  if (!canRunLocal) {
    return (
      <section id={`${domId(props.tab)}-panel`} aria-label="Terminal" data-terminal-tab className="flex min-h-0 flex-1 flex-col bg-panel">
        <EmptyState title="Terminal runs on your computer">{ON_YOUR_COMPUTER}</EmptyState>
      </section>
    );
  }

  if (!bridge.openTerminal) {
    return (
      <section id={`${domId(props.tab)}-panel`} aria-label="Terminal" data-terminal-tab className="flex min-h-0 flex-1 flex-col bg-panel">
        <EmptyState title="Terminal unavailable">Update Octo&apos;s local service to open interactive terminals.</EmptyState>
      </section>
    );
  }

  if (folders.length === 0) {
    return (
      <section id={`${domId(props.tab)}-panel`} aria-label="Terminal" data-terminal-tab className="flex min-h-0 flex-1 flex-col bg-panel">
        <EmptyState
          title="No project folder"
          actions={
            ws ? (
              <Button variant="primary" size="sm" onClick={ws.openSettings}>
                Project settings
              </Button>
            ) : undefined
          }
        >
          Add a folder to this project to open an interactive shell in it.
        </EmptyState>
      </section>
    );
  }

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
    <section
      id={`${domId(props.tab)}-panel`}
      aria-label="Terminal"
      data-terminal-tab
      tabIndex={-1}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) termRef.current?.focus();
      }}
      className="flex min-h-0 flex-1 flex-col bg-panel outline-none"
    >
      <header className="flex h-bar shrink-0 items-center justify-between gap-2 border-b border-line px-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Work-surface polish item 10: the PID lives in the status dot's tooltip, not in the bar. */}
          <span role="img" aria-label={statusTip} title={statusTip} className="grid size-4 shrink-0 place-items-center">
            <span
              className={cn(
                "size-2 rounded-full",
                snap.status === "running" ? "bg-ok" : snap.status === "connecting" ? "bg-accent" : snap.status === "error" ? "bg-err" : "bg-fg-3",
              )}
            />
          </span>
          <span className="font-mono text-xs font-medium text-fg">{snap.shell || "shell"}</span>
          {folders.length > 1 ? (
            <MenuButton label="Working folder" text={activeFolder} items={folderItems} />
          ) : (
            <span className="truncate font-mono text-xs text-fg-2">{activeFolder}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
        </div>
      </header>

      {(snap.error !== null || snap.status === "exited") && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <span className={cn("truncate text-xs", snap.error !== null ? "text-err" : "text-fg-2")}>
            {snap.error ?? `Process exited (code ${snap.exitCode ?? 0}). Press Enter or Restart to open a new shell.`}
          </span>
          <Button variant="secondary" size="sm" onClick={() => restart()}>
            Restart
          </Button>
        </div>
      )}

      <div data-terminal-screen onClick={() => termRef.current?.focus()} className="min-h-0 flex-1 overflow-hidden p-2">
        <div ref={hostRef} data-audit-ignore className="h-full w-full" />
      </div>
    </section>
  );
}
