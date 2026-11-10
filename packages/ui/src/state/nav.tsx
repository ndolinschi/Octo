import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/** A request (orchestrator user message) in one project. */
export type TurnRef = { projectId: string; messageId: number };

type Listener = (turn: TurnRef) => void;

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
  /** The workspace registers how many unsaved files leaving it would discard. */
  setLeaveGuard(count: (() => number) | null): void;
  unsavedCount(): number;
  /** The workspace registers its side-pane toggle (for the palette). */
  setPaneToggle(toggle: (() => void) | null): void;
  togglePane(): boolean;
};

type NavState = {
  /** The request whose turn is at the top of the open conversation. */
  viewTurn: TurnRef | null;
};

const ActionsContext = createContext<NavActions | null>(null);
const StateContext = createContext<NavState>({ viewTurn: null });

export function NavProvider({ children }: { children: ReactNode }) {
  const [viewTurn, setViewTurnState] = useState<TurnRef | null>(null);
  const pending = useRef<TurnRef | null>(null);
  const listeners = useRef(new Set<Listener>());
  const guard = useRef<(() => number) | null>(null);
  const pane = useRef<(() => void) | null>(null);

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
      setViewTurn: (turn) =>
        setViewTurnState((prev) =>
          prev?.projectId === turn?.projectId && prev?.messageId === turn?.messageId ? prev : turn,
        ),
      setLeaveGuard: (count) => {
        guard.current = count;
      },
      unsavedCount: () => guard.current?.() ?? 0,
      setPaneToggle: (toggle) => {
        pane.current = toggle;
      },
      togglePane: () => {
        if (!pane.current) return false;
        pane.current();
        return true;
      },
    }),
    [],
  );
  const state = useMemo(() => ({ viewTurn }), [viewTurn]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useNav(): NavActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useNav outside NavProvider");
  return ctx;
}

/** Null outside the app shell (e.g. a transcript embedded elsewhere). */
export function useOptionalNav(): NavActions | null {
  return useContext(ActionsContext);
}

export function useNavState(): NavState {
  return useContext(StateContext);
}
