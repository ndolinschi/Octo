import { errorMessage } from "../../../lib/format";

export type PhoneMoreAsyncHooks = {
  setPending(value: string | null): void;
  setProblem(value: string | null): void;
  closeAndRun(fn: () => void): void;
  isMounted?: () => boolean;
};

/**
 * Runs "New session" while keeping the sheet open and busy; closes and switches only on success so failures render in the
 * sheet's error Notice instead of being lost after unmount.
 */
export async function runPhoneMoreCreateSession<TSession extends { id: string }>(
  deps: {
    projectId: string;
    createSession(projectId: string): Promise<{ session: TSession }>;
    applySession(action: { kind: "upsert"; session: TSession }): void;
    refreshSessions(): void;
    showSession(id: string): void;
  },
  hooks: PhoneMoreAsyncHooks,
): Promise<boolean> {
  const live = () => hooks.isMounted?.() ?? true;
  hooks.setProblem(null);
  hooks.setPending("new-session");
  try {
    const { session } = await deps.createSession(deps.projectId);
    if (!live()) return true;
    hooks.setPending(null);
    hooks.closeAndRun(() => {
      deps.applySession({ kind: "upsert", session });
      deps.refreshSessions();
      deps.showSession(session.id);
    });
    return true;
  } catch (e: unknown) {
    if (!live()) return false;
    hooks.setPending(null);
    hooks.setProblem(`The session was not created: ${errorMessage(e).replace(/\.$/, "")}. Try again from the menu.`);
    return false;
  }
}

/**
 * Runs or opens a project command from the phone sheet. Already-running commands close and open immediately; starting a new
 * command stays open while pending, closes only on success, and surfaces any failure in the sheet's error Notice.
 */
export async function runPhoneMoreCommand(
  deps: {
    name: string;
    alreadyRunning: boolean;
    startRun: (() => Promise<{ runId: string } | { problem: string }>) | null;
    openRun(name: string): void;
  },
  hooks: PhoneMoreAsyncHooks,
): Promise<boolean> {
  if (deps.alreadyRunning || !deps.startRun) {
    hooks.closeAndRun(() => deps.openRun(deps.name));
    return true;
  }
  const live = () => hooks.isMounted?.() ?? true;
  hooks.setProblem(null);
  hooks.setPending(`run:${deps.name.toLowerCase()}`);
  const r = await deps.startRun();
  if (!live()) return !("problem" in r);
  hooks.setPending(null);
  if ("problem" in r) {
    hooks.setProblem(r.problem);
    return false;
  }
  hooks.closeAndRun(() => deps.openRun(deps.name));
  return true;
}
