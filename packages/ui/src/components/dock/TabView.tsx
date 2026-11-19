import { sessionRoot } from "@octo/agent-client";
import { lazy, Suspense, useCallback, useState, type ComponentType } from "react";
import { readyLazy } from "../../lib/readyLazy";
import { registerWarm } from "../../lib/warm";
import { resolveSessionRoute } from "../../lib/route";
import { sessionTabMode } from "../../lib/sessions/current";
import { isTabEnabled } from "../../lib/tabFlags";
import { SessionScope } from "../../state/session";
import { useTabFlags } from "../../state/tabFlags";
import { FileViewSkeleton } from "../files/EditorSkeleton";
import { useProject } from "../../state/project";
import { FloatRoomContext } from "../primitives/floatRoom";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { FloatingBlockContext, useFloatingHere } from "../../state/workspace/useFloatingHere";
import { ConversationView } from "../chat/ConversationView";
import { transcriptPart } from "../chat/transcriptPart";
import { useNow } from "../../lib/hooks";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { TranscriptSlot } from "../sessions/parts";
import type { FloatingSlot } from "../files/FileView";

/**
 * A tool's view in its own chunk, warmed under `key` on idle and on intent (`lib/warm`: the "+" picker's row, the sidebar's
 * Review), so its first open renders at once (`readyLazy`) instead of suspending.
 */
function warmedTool<P extends object>(key: string, load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const part = readyLazy(load);
  registerWarm(key, part.fetch);
  return part.Component;
}

/** The file view (breadcrumbs, tree column, editor host) and its floating composer load with the first file or Files tab. */
const FileView = warmedTool("tool:files", () => import("../files/FileView").then((m) => m.FileView));
const FloatingComposer = warmedTool("tool:files", () => import("../chat/FloatingComposer").then((m) => m.FloatingComposer));

/** What a file view renders as its floating composer: the dock, not the file feature, knows about chat. */
const renderFloatingComposer: FloatingSlot = (onHeight, rest) => <ScopedFloatingComposer onHeight={onHeight} rest={rest} />;

/** Decision 96: the floating composer sends to the session of the conversation focused last (Chat's, else a session tab's). */
function ScopedFloatingComposer(props: { onHeight(px: number): void; rest?: boolean }) {
  const ws = useOptionalWorkspace();
  const { state } = useProject();
  return (
    <SessionScope sessionId={ws?.focusedSessionId ?? state.sessions.defaultId}>
      <Suspense fallback={null}>
        <FloatingComposer onHeight={props.onHeight} rest={props.rest ?? false} />
      </Suspense>
    </SessionScope>
  );
}

/** The Details tab loads when it is first opened (its own chunk). */
const DetailsPanel = lazy(() => import("../details/DetailsPanel").then((m) => ({ default: m.DetailsPanel })));
/** Agents and Notes load when first opened too (their own chunks). */
const AgentsPanel = lazy(() => import("../agents/AgentsPanel").then((m) => ({ default: m.AgentsPanel })));
const NotesPanel = lazy(() => import("../notes/NotesPanel").then((m) => ({ default: m.NotesPanel })));
/** Changes (v7): the diff review of what the agents changed. */
const ChangesPane = warmedTool("tool:changes", () => import("./ChangesPane").then((m) => m.ChangesPane));
/** Memory (its own chunk). */
const MemoryTab = lazy(() => import("../memory/MemoryTab").then((m) => ({ default: m.MemoryTab })));
/** Sessions (project sessions): the list-detail tab and one session in a tab of its own. Their own chunks. */
const SessionsTab = lazy(() => import("../sessions/SessionsTab").then((m) => ({ default: m.SessionsTab })));
const SessionPane = lazy(() => import("../sessions/SessionPane").then((m) => ({ default: m.SessionPane })));
const SessionGone = lazy(() => import("../sessions/SessionGone").then((m) => ({ default: m.SessionGone })));

/** The transcript's own chunk (`transcriptPart`). */
const Transcript = transcriptPart.Component;

/** A session's conversation is drawn by the project chat's own `Transcript`; the sessions feature receives it as a slot. */
function SessionTranscript(props: Parameters<TranscriptSlot>[0]) {
  const now = useNow(props.agent.status === "running");
  return (
    <Suspense fallback={null}>
      <Transcript
        agent={props.agent}
        messages={props.messages}
        now={now}
        watched
        speaker={props.speaker}
        promptAuthor={props.promptAuthor}
        hideFirstPrompt={props.hideFirstPrompt}
        density={props.density}
        onOpenSession={props.onOpenSession}
      />
    </Suspense>
  );
}
const renderSessionTranscript: TranscriptSlot = (props) => <SessionTranscript {...props} />;

/** Review (RV2): pick a pull request, read it, comment, submit. Monaco comes from the files feature, as for Changes. */
const ReviewTab = warmedTool("tool:review", () => import("../review/ReviewTab").then((m) => m.ReviewTab));
const loadReviewMonaco = () => import("../files/monaco");
/** Run buttons and the run panel of a review (decision 68): its own chunk, handed to the review as a kit. */
const loadReviewCommands = () => import("../commands/kit").then((m) => m.reviewCommandsKit);
/** The output of a project command (decision 68): the commands feature's run panel in a tab, its own chunk. */
const RunTab = lazy(() => import("../commands/RunTab"));
/** Browser + Design Mode (singleton `tool:browser` and multi-instance `browser:<id>`): its own chunk. */
const BrowserTab = warmedTool("tool:browser", () => import("../browser/BrowserTab").then((m) => m.default));
/** Interactive PTY shell (singleton `tool:terminal` and multi-instance `terminal:<id>`): its own chunk. */
const TerminalTab = warmedTool("tool:terminal", () => import("../terminal/TerminalTab").then((m) => m.default));
/** Working processes, dev servers and background workers (`tool:processes`): its own chunk. */
const ProcessesTab = warmedTool("tool:processes", () => import("../processes/ProcessesTab").then((m) => m.default));
/** The side question (decision 40). */
const SidePanel = lazy(() => import("../side/SidePanel").then((m) => ({ default: m.SidePanel })));
/** The Usage tab too (v6.2). */
const UsagePanel = lazy(() => import("../usage/UsagePanel").then((m) => ({ default: m.UsagePanel })));

function ScopedDetailsPanel() {
  const ws = useOptionalWorkspace();
  const { state } = useProject();
  return (
    <SessionScope sessionId={ws?.focusedSessionId ?? state.sessions.defaultId}>
      <DetailsPanel />
    </SessionScope>
  );
}

/** The view behind a tab. The Files tab is the file view with no file open yet. */
export function TabView({ tab }: { tab: TabId }) {
  const { project } = useProject();
  const tabFlags = useTabFlags();
  const ref = parseTab(tab);
  if (!ref || !project) return null;
  switch (ref.kind) {
    case "chat":
      return <ChatTab tab={tab} />;
    case "agent":
      return <ConversationView agentId={ref.agentId} tab={tab} />;
    case "file":
      return (
        <Suspense fallback={<FileViewSkeleton />}>
          <FileView tab={tab} fileKey={ref.key} floatingComposer={renderFloatingComposer} />
        </Suspense>
      );
    case "session":
      return <SessionTab sessionId={ref.sessionId} tab={tab} />;
    case "run":
      return (
        <Suspense fallback={null}>
          <RunTab name={ref.name} />
        </Suspense>
      );
    case "browser":
      if (!tabFlags.browser) return null;
      return (
        <Suspense fallback={null}>
          <BrowserTab tab={tab} browserId={ref.browserId} />
        </Suspense>
      );
    case "terminal":
      if (!tabFlags.terminal) return null;
      return (
        <Suspense fallback={null}>
          <TerminalTab tab={tab} terminalId={ref.terminalId} />
        </Suspense>
      );
    case "tool":
      if (!isTabEnabled(tabFlags, ref.tool, { memoryBlocked: project.memory?.auto_memory === "blocked" })) return null;
      if (ref.tool === "browser")
        return (
          <Suspense fallback={null}>
            <BrowserTab tab={tab} browserId="default" />
          </Suspense>
        );
      if (ref.tool === "terminal")
        return (
          <Suspense fallback={null}>
            <TerminalTab tab={tab} terminalId="default" />
          </Suspense>
        );
      if (ref.tool === "processes")
        return (
          <ToolView tab={tab}>
            <Suspense fallback={null}>
              <ProcessesTab />
            </Suspense>
          </ToolView>
        );
      if (ref.tool === "files")
        return (
          <Suspense fallback={<FileViewSkeleton />}>
            <FileView tab={tab} fileKey={null} floatingComposer={renderFloatingComposer} />
          </Suspense>
        );
      // Its own input: no floating composer over it (two inputs would compete).
      if (ref.tool === "side")
        return (
          <Suspense fallback={null}>
            <SidePanel />
          </Suspense>
        );
      if (ref.tool === "changes")
        return (
          <ToolView tab={tab}>
            <Suspense fallback={null}>
              <ChangesPane />
            </Suspense>
          </ToolView>
        );
      // Its own inputs and keys: no floating composer over it.
      if (ref.tool === "review")
        return (
          <Suspense fallback={null}>
            <ReviewTab loadMonaco={loadReviewMonaco} loadCommands={loadReviewCommands} />
          </Suspense>
        );
      // Its own list, detail and composer: no floating composer over it.
      if (ref.tool === "sessions") return <SessionsToolTab />;
      if (ref.tool === "memory")
        return (
          <ToolView tab={tab}>
            <Suspense fallback={null}>
              <MemoryTab />
            </Suspense>
          </ToolView>
        );
      return (
        <ToolView tab={tab}>
          <Suspense fallback={null}>
            {ref.tool === "agents" ? <AgentsPanel /> : ref.tool === "notes" ? <NotesPanel /> : ref.tool === "usage" ? <UsagePanel /> : <ScopedDetailsPanel />}
          </Suspense>
        </ToolView>
      );
  }
}

function SessionsToolTab() {
  const ws = useOptionalWorkspace();
  return (
    <Suspense fallback={null}>
      <SessionsTab renderTranscript={renderSessionTranscript} onOpenInTab={ws ? (id) => ws.openSession(id) : undefined} />
    </Suspense>
  );
}

/** Chat: the conversation of the main session the workspace shows there (decision 96), else the project's own. */
function ChatTab({ tab }: { tab: TabId }) {
  const ws = useOptionalWorkspace();
  const sid = ws?.chatSessionId ?? null;
  return <SessionConversation sessionId={sid} tab={tab} onFollow={(next) => ws?.followSession(sid, next)} />;
}

/**
 * One main session's conversation in a tab: the shared `ConversationView` inside that session's scope (its root agent, queue,
 * approvals, composer). `sessionId` null is the default session. A session that no longer exists says so (the project's
 * gone state, P1-4) instead of showing another session.
 */
function SessionConversation(props: { sessionId: string | null; tab: TabId; onFollow(next: string): void }) {
  const { project, state, synced, parallel } = useProject();
  const ws = useOptionalWorkspace();
  if (!project) return null;
  if (parallel && resolveSessionRoute(props.sessionId, synced > 0 ? state.sessions.list : null) === "missing") {
    const fallback = state.sessions.defaultId;
    return (
      <Suspense fallback={null}>
        <SessionGone sessionId={props.sessionId} onDefault={fallback !== null ? () => ws?.followSession(props.sessionId, fallback) : undefined} />
      </Suspense>
    );
  }
  const sid = props.sessionId ?? state.sessions.defaultId;
  const root = (sid !== null && parallel ? sessionRoot(state, sid) : "") || project.orchestrator_agent_id;
  // Chat on "the default session" keeps one conversation (and the tab's own draft) while the default is learnt or moves.
  return (
    <SessionScope sessionId={sid} keyed={props.sessionId !== null} onFollow={props.onFollow}>
      <ConversationView key={props.sessionId ?? "default"} agentId={root} tab={props.tab} />
    </SessionScope>
  );
}

function SessionTab({ sessionId, tab }: { sessionId: string; tab: TabId }) {
  const ws = useOptionalWorkspace();
  const { state, parallel, synced } = useProject();
  const known = state.sessions.list.find((x) => x.id === sessionId);
  const mode = sessionTabMode({ parallel, kind: known?.kind, synced });
  if (mode === "loading") return null;
  // A main session's own tab is its conversation (decision 96: two sessions side by side); an agent session's, its detail.
  if (mode === "conversation") return <SessionConversation sessionId={sessionId} tab={tab} onFollow={(next) => ws?.followSession(sessionId, next)} />;
  return (
    <Suspense fallback={null}>
      <SessionPane sessionId={sessionId} renderTranscript={renderSessionTranscript} onClose={ws ? () => ws.dropTab(tab) : undefined} />
    </Suspense>
  );
}

/**
 * Agents, Notes, Details and Usage: the floating composer sits over them too when no Chat tab is visible, and
 * their lists reserve its height + 16 at the end (`FloatRoom`, the editor's rule), so the last row can
 * always be scrolled above it.
 */
function ToolView({ tab, children }: { tab: TabId; children: React.ReactNode }) {
  // A form with its own input (note editor, memory file editor, "Add") takes the composer away while it is open.
  const [forms, setForms] = useState(0);
  const countForms = useCallback((delta: 1 | -1) => setForms((n) => n + delta), []);
  const floating = useFloatingHere(tab) && forms === 0;
  const [height, setHeight] = useState(0);
  const room = floating && height > 0 ? height + 16 : 0;
  return (
    <FloatingBlockContext.Provider value={countForms}>
      <FloatRoomContext.Provider value={room}>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {children}
          {floating && <ScopedFloatingComposer onHeight={setHeight} />}
        </div>
      </FloatRoomContext.Provider>
    </FloatingBlockContext.Provider>
  );
}
