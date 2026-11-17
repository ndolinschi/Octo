import type { Bridge, TerminalSession } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { getTerminalTabState, onTerminalTabClosed, updateTerminalTabState } from "../../state/terminalTabs";

const MAX_HISTORY_BYTES = 128 * 1024;

export type TerminalStatus = "connecting" | "running" | "exited" | "error";

export type TerminalSnapshot = {
  status: TerminalStatus;
  shell: string;
  folder: string;
  cwd: string;
  pid: number;
  exitCode: number | null;
  error: string | null;
};

export type ManagedTerminal = {
  snapshot(): TerminalSnapshot;
  history(): readonly Uint8Array[];
  subscribe(listener: () => void): () => void;
  onOutput(listener: (chunk: Uint8Array) => void): () => void;
  start(bridge: Bridge, cols: number, rows: number, nextFolder?: string): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  clearHistory(): void;
};

type InternalEntry = {
  projectId: string;
  terminalId: string;
  session: TerminalSession | null;
  unsubOutput: (() => void) | null;
  unsubExit: (() => void) | null;
  gen: number;
  snap: TerminalSnapshot;
  chunks: Uint8Array[];
  bytes: number;
  listeners: Set<() => void>;
  outputListeners: Set<(chunk: Uint8Array) => void>;
  api: ManagedTerminal;
};

const entries = new Map<string, InternalEntry>();

function disposeSession(entry: InternalEntry) {
  entry.gen += 1;
  entry.unsubOutput?.();
  entry.unsubExit?.();
  entry.unsubOutput = null;
  entry.unsubExit = null;
  const prev = entry.session;
  entry.session = null;
  if (prev) {
    void prev.close().catch(() => undefined);
  }
}

onTerminalTabClosed((projectId, terminalId) => {
  const key = `${projectId}:${terminalId}`;
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  disposeSession(entry);
});

export function getManagedTerminal(projectId: string, terminalId: string, defaultFolder: string): ManagedTerminal {
  const key = `${projectId}:${terminalId}`;
  const existing = entries.get(key);
  if (existing) return existing.api;

  const meta = getTerminalTabState(projectId, terminalId);
  const initialFolder = meta.folder || defaultFolder;

  const entry: InternalEntry = {
    projectId,
    terminalId,
    session: null,
    unsubOutput: null,
    unsubExit: null,
    gen: 0,
    snap: {
      status: "connecting",
      shell: meta.shell,
      folder: initialFolder,
      cwd: "",
      pid: 0,
      exitCode: null,
      error: null,
    },
    chunks: [],
    bytes: 0,
    listeners: new Set(),
    outputListeners: new Set(),
    api: null as unknown as ManagedTerminal,
  };

  const notify = () => {
    entry.listeners.forEach((fn) => fn());
  };

  const appendChunk = (chunk: Uint8Array) => {
    entry.chunks.push(chunk);
    entry.bytes += chunk.byteLength;
    while (entry.bytes > MAX_HISTORY_BYTES && entry.chunks.length > 1) {
      const removed = entry.chunks.shift();
      if (removed) entry.bytes -= removed.byteLength;
    }
    entry.outputListeners.forEach((fn) => fn(chunk));
  };

  entry.api = {
    snapshot: () => entry.snap,
    history: () => entry.chunks,
    subscribe: (listener) => {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    onOutput: (listener) => {
      entry.outputListeners.add(listener);
      return () => {
        entry.outputListeners.delete(listener);
      };
    },
    start: (bridge, cols, rows, nextFolder) => {
      if (!bridge.openTerminal) {
        entry.snap = { ...entry.snap, status: "error", error: "Octo's local service does not support terminals." };
        notify();
        return;
      }
      if (nextFolder === undefined && (entry.session !== null || (entry.gen > 0 && entry.snap.status === "connecting"))) {
        return;
      }
      disposeSession(entry);
      const folder = nextFolder ?? (entry.snap.folder || defaultFolder);
      const myGen = entry.gen;
      entry.snap = {
        ...entry.snap,
        status: "connecting",
        folder,
        pid: 0,
        exitCode: null,
        error: null,
      };
      updateTerminalTabState(projectId, terminalId, { folder });
      notify();

      bridge
        .openTerminal(projectId, { folder, cols: Math.max(20, cols), rows: Math.max(5, rows) })
        .then((session) => {
          if (entry.gen !== myGen) {
            void session.close().catch(() => undefined);
            return;
          }
          entry.session = session;
          entry.snap = {
            status: "running",
            shell: session.shell,
            folder: session.folder || folder,
            cwd: session.cwd,
            pid: session.pid,
            exitCode: null,
            error: null,
          };
          updateTerminalTabState(projectId, terminalId, {
            shell: session.shell,
            folder: session.folder || folder,
          });
          entry.unsubOutput = session.onOutput((chunk) => {
            if (entry.gen !== myGen) return;
            appendChunk(chunk);
          });
          entry.unsubExit = session.onExit((exit) => {
            if (entry.gen !== myGen) return;
            entry.session = null;
            entry.snap = {
              ...entry.snap,
              status: "exited",
              pid: 0,
              exitCode: exit.code,
            };
            notify();
          });
          notify();
        })
        .catch((err: unknown) => {
          if (entry.gen !== myGen) return;
          entry.snap = {
            ...entry.snap,
            status: "error",
            pid: 0,
            error: errorMessage(err),
          };
          notify();
        });
    },
    write: (data) => {
      if (!entry.session) return;
      void entry.session.write(data).catch(() => undefined);
    },
    resize: (cols, rows) => {
      if (!entry.session || cols < 2 || rows < 1) return;
      void entry.session.resize(cols, rows).catch(() => undefined);
    },
    clearHistory: () => {
      entry.chunks = [];
      entry.bytes = 0;
    },
  };

  entries.set(key, entry);
  return entry.api;
}
