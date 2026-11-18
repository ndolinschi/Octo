import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createRequiredContext } from "../lib/context";
import type { Layout, TabId, ToolTab } from "./workspace/layout";

/** A request (orchestrator user message) in one project. */
export type TurnRef = { projectId: string; messageId: number };

type Listener = (turn: TurnRef) => void;

/** A tool tab to open when a project's workspace mounts (Home's Tokens card opens Usage over all projects). */
export type ToolRequest = { projectId: string; tool: "usage"; scope: "project" | "all" };

/** One palette row offered by the open workspace (tabs and tab actions). */
/** `search`: text that is searched but not shown (a tool's purpose). */
export type WorkspaceCommand = { id: string; label: string; detail?: string; search?: string; shortcut?: string; run(): void };

/** What the palette's workspace rows need from the open workspace (`workspace/paletteCommands`). */
export type PaletteWorkspace = {
  layout: Layout;
  narrow: boolean;
  memoryBlocked?: boolean;
  toolEnabled?(tool: ToolTab): boolean;
  openTool(tool: ToolTab): void;
  openPicker(): void;
  canMoveToOtherSide(tab: TabId): boolean;
  moveToOtherSide(tab: TabId): void;
  canSplitRight(tab: TabId): boolean;
  splitRight(tab: TabId): void;
  canClose?(tab: TabId): boolean;
  requestClose(tabs: TabId[]): void;
  closeOthers(tab: TabId): void;
  equalize(): void;
  activate(tab: TabId): void;
  /** The name of a tab that has no button in the strip now (hidden in "All tabs"): what the strip would show. */
  tabName?(tab: TabId): string | undefined;
};

/** What the open project workspace lets the shell (palette) do. */
export type WorkspaceApi = {
  openAgent(agentId: string): void;
  focusChat(): void;
  /** Opens (or focuses) a tool tab, e.g. the sidebar's Review row. */
  openTool(tool: ToolTab): void;
  /** Decision 96: a main session in a tab of its own (the sidebar's "Open in new tab"). */
  openSession(sessionId: string): void;
  /** Switches the active conversation to `sessionId`. */
  showSession?(sessionId: string): void;
  /** Closes `tab` immediately without confirmation (e.g. when its session was deleted). */
  dropTab?(tab: TabId): void;
  /** The workspace as it is now, for the palette's tab actions and tab rows (`workspace/paletteCommands`). */
  current(): PaletteWorkspace;
};

/**
 * Stable cross-cutting actions between the shell (sidebar, palette) and the open workspace.
 * Kept apart from `NavState` so components that only act never re-render on scroll.
 */
type NavActions = {
  /** Ask the conversation to scroll to a request; kept until a conversation takes it. */
  requestTurn(turn: TurnRef): void;
  /** Takes (and clears) the pending request for this project, if any. */
  takePendingTurn(projectId: string): TurnRef | null;
  onTurnRequest(listener: Listener): () => void;
  clearPendingTurn(): void;
  setViewTurn(turn: TurnRef | null): void;
  /** Ask the next workspace of this project to open a tool tab; kept until that workspace takes it. */
  requestTool(request: ToolRequest): void;
  takePendingTool(projectId: string): ToolRequest | null;
  /** The workspace registers how many unsaved files leaving it would discard. */
  setLeaveGuard(count: (() => number) | null): void;
  unsavedCount(): number;
  /** The open workspace registers itself (for the palette). */
  setWorkspace(api: WorkspaceApi | null): void;
  workspace(): WorkspaceApi | null;
};

type NavState = {
  /** The request whose turn is at the top of the open conversation. */
  viewTurn: TurnRef | null;
};

export const { Provider: NavContextProvider, useRequired: useNav, useOptional: useOptionalNav } = createRequiredContext<NavActions>("useNav");
const StateContext = createContext<NavState>({ viewTurn: null });

export function NavProvider({ children }: { children: ReactNode }) {
  const [viewTurn, setViewTurnState] = useState<TurnRef | null>(null);
  const pending = useRef<TurnRef | null>(null);
  const pendingTool = useRef<ToolRequest | null>(null);
  const listeners = useRef(new Set<Listener>());
  const guard = useRef<(() => number) | null>(null);
  const workspace = useRef<WorkspaceApi | null>(null);

  const actions = useMemo<NavActions>(
    () => ({
      requestTurn: (turn) => {
        pending.current = turn;
        for (const l of listeners.current) l(turn);
      },
      takePendingTurn: (projectId) => {
        const p = pending.current;
        if (!p || p.projectId !== projectId) return null;
        pending.current = null;
        return p;
      },
      onTurnRequest: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      clearPendingTurn: () => {
        pending.current = null;
      },
      setViewTurn: (turn) => setViewTurnState((prev) => (prev?.projectId === turn?.projectId && prev?.messageId === turn?.messageId ? prev : turn)),
      requestTool: (request) => {
        pendingTool.current = request;
      },
      takePendingTool: (projectId) => {
        const p = pendingTool.current;
        if (p?.projectId !== projectId) return null;
        pendingTool.current = null;
        return p;
      },
      setLeaveGuard: (count) => {
        guard.current = count;
      },
      unsavedCount: () => guard.current?.() ?? 0,
      setWorkspace: (api) => {
        workspace.current = api;
      },
      workspace: () => workspace.current,
    }),
    [],
  );
  const state = useMemo(() => ({ viewTurn }), [viewTurn]);

  return (
    <NavContextProvider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </NavContextProvider>
  );
}

export function useNavState(): NavState {
  return useContext(StateContext);
}
