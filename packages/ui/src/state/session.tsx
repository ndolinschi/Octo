import { eventInSession, scopeState, sessionBridge, sessionRoot, type ProjectSession } from "@octo/agent-client";
import { useMemo, type ReactNode } from "react";
import { createRequiredContext } from "../lib/context";
import { useLatest } from "../lib/hooks";
import { AppContextProvider, useApp } from "./app";
import { ProjectContextProvider, useProject } from "./project";
import { sessionTab, type TabId } from "./workspace/layout";

export type SessionScopeValue = {
  /** The main session this part of the screen shows and sends to. */
  sessionId: string;
  /** Its record (absent until the list has it). */
  session: ProjectSession | undefined;
  isDefault: boolean;
  /**
   * Where the session's draft, local queue and scroll position are kept in the tab memory: its own key, or null for the tab's
   * (Chat while it shows "the default session", whichever that is: its draft stays when the default moves or the list arrives).
   */
  memoryKey: TabId | null;
  /** `/clear` made session `next` from this one: the view follows it (the tab now shows `next`). */
  follow(next: string): void;
};

export const { Provider: SessionScopeProvider, useOptional: useSessionScope } = createRequiredContext<SessionScopeValue>("useSessionScope");

/**
 * Parallel sessions (UI decision 96): everything under it is about one main session. It re-provides the project as that
 * session sees it — its root agent as the project's orchestrator, its queue, last turn, outcomes, approvals, forms and
 * attention (`scopeState`), `running`, `send` and `cancel` for it, the events that concern it — and the bridge addressed to
 * it (`sessionBridge`), so the conversation, the composer and their slots need no session argument. Without parallel
 * sessions (an older harness) or without a session id it renders its children as they are (the default session).
 */
export function SessionScope(props: {
  sessionId: string | null;
  /** False: the memory key is the tab's own (see `memoryKey`). */
  keyed?: boolean;
  onFollow?: ((next: string) => void) | undefined;
  children: ReactNode;
}) {
  // One element tree whether or not the session is known yet (the sessions list arrives after the first paint): the
  // conversation under it is never mounted again when it arrives.
  return (
    <Scoped sessionId={props.sessionId} keyed={props.keyed ?? true} onFollow={props.onFollow}>
      {props.children}
    </Scoped>
  );
}

function Scoped(props: { sessionId: string | null; keyed: boolean; onFollow?: ((next: string) => void) | undefined; children: ReactNode }) {
  const app = useApp();
  const base = useProject();
  const active = base.parallel && props.sessionId !== null;
  const sid = props.sessionId ?? "";
  const { state, project } = base;
  const follow = useLatest(props.onFollow);
  const session = state.sessions.list.find((s) => s.id === sid);
  const isDefault = state.sessions.defaultId === sid;
  const root = sessionRoot(state, sid) || (isDefault && project ? project.orchestrator_agent_id : "");
  const rootAgent = root ? state.agents[root] : undefined;
  const running = rootAgent ? rootAgent.status === "running" : session?.state === "working" || session?.state === "waiting";

  // The scoped bridge keeps its identity while the app's other values move (health, projects): views that load through it
  // (a turn's changes, the queue) must not read again on every poll.
  const scopedBridge = useMemo(() => (active ? sessionBridge(app.bridge, sid) : app.bridge), [active, app.bridge, sid]);
  const scopedApp = useMemo(() => (active ? { ...app, bridge: scopedBridge } : app), [active, app, scopedBridge]);
  const scopedState = useMemo(() => (active ? scopeState(state, sid) : state), [active, state, sid]);
  const { sendIn, cancelIn, onEvent, applyRewind } = base;
  const scopedProject = useMemo(() => (project ? { ...project, orchestrator_agent_id: root } : null), [project, root]);
  const scopedSend = useMemo(
    () => async (text: string, opts?: Parameters<typeof base.send>[1]) => {
      await sendIn(sid, text, opts);
    },
    [sendIn, sid],
  );
  const scopedCancel = useMemo(() => () => cancelIn(sid), [cancelIn, sid]);
  const scopedRewind = useMemo(() => (messageId: number, label: string) => applyRewind(messageId, label, root || undefined), [applyRewind, root]);
  const scopedOnEvent = useMemo(() => (listener: Parameters<typeof base.onEvent>[0]) => onEvent((e) => eventInSession(e, sid) && listener(e)), [onEvent, sid]);
  const value = useMemo(
    () =>
      !active
        ? base
        : {
            ...base,
            project: scopedProject,
            state: scopedState,
            running,
            send: scopedSend,
            cancel: scopedCancel,
            applyRewind: scopedRewind,
            onEvent: scopedOnEvent,
          },
    [active, base, scopedProject, scopedState, running, scopedSend, scopedCancel, scopedRewind, scopedOnEvent],
  );
  const keyed = props.keyed;
  const scope = useMemo<SessionScopeValue | null>(
    () => (active ? { sessionId: sid, session, isDefault, memoryKey: keyed ? sessionTab(sid) : null, follow: (next) => follow.current?.(next) } : null),
    [active, sid, session, isDefault, keyed, follow],
  );
  return (
    <AppContextProvider value={scopedApp}>
      <ProjectContextProvider value={value}>
        <SessionScopeProvider value={scope}>{props.children}</SessionScopeProvider>
      </ProjectContextProvider>
    </AppContextProvider>
  );
}
