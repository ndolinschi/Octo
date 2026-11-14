import { lazy, Suspense, useCallback, useState } from "react";
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
import { FloatingComposer } from "../chat/FloatingComposer";
import type { FloatingSlot } from "../files/FileView";

/** The file view (breadcrumbs, tree column, editor host) loads with the first file or Files tab: its own chunk. */
const FileView = lazy(() => import("../files/FileView").then((m) => ({ default: m.FileView })));

/** What a file view renders as its floating composer: the dock, not the file feature, knows about chat. */
const renderFloatingComposer: FloatingSlot = (onHeight, rest) => <FloatingComposer onHeight={onHeight} rest={rest} />;

/** The Details tab loads when it is first opened (its own chunk). */
const DetailsPanel = lazy(() => import("../details/DetailsPanel").then((m) => ({ default: m.DetailsPanel })));
/** Agents and Notes load when first opened too (their own chunks). */
const AgentsPanel = lazy(() => import("../agents/AgentsPanel").then((m) => ({ default: m.AgentsPanel })));
const NotesPanel = lazy(() => import("../notes/NotesPanel").then((m) => ({ default: m.NotesPanel })));
/** Changes (v7): the diff review of what the agents changed. */
const ChangesPane = lazy(() => import("./ChangesPane").then((m) => ({ default: m.ChangesPane })));
/** Memory (its own chunk). */
const MemoryTab = lazy(() => import("../memory/MemoryTab").then((m) => ({ default: m.MemoryTab })));
/** Sessions (project sessions): the list-detail tab and one session in a tab of its own. Their own chunks. */
const SessionsTab = lazy(() => import("../sessions/SessionsTab").then((m) => ({ default: m.SessionsTab })));
const SessionPane = lazy(() => import("../sessions/SessionPane").then((m) => ({ default: m.SessionPane })));

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
const ReviewTab = lazy(() => import("../review/ReviewTab").then((m) => ({ default: m.ReviewTab })));
const loadReviewMonaco = () => import("../files/monaco");
/** Run buttons and the run panel of a review (decision 68): its own chunk, handed to the review as a kit. */
const loadReviewCommands = () => import("../commands/kit").then((m) => m.reviewCommandsKit);
/** The output of a project command (decision 68): the commands feature's run panel in a tab, its own chunk. */
const RunTab = lazy(() => import("../commands/RunTab"));
/** The side question (decision 40). */
const SidePanel = lazy(() => import("../side/SidePanel").then((m) => ({ default: m.SidePanel })));
/** The Usage tab too (v6.2). */
const UsagePanel = lazy(() => import("../usage/UsagePanel").then((m) => ({ default: m.UsagePanel })));

/** The view behind a tab. The Files tab is the file view with no file open yet. */
export function TabView({ tab }: { tab: TabId }) {
  const { project } = useProject();
  const ref = parseTab(tab);
  if (!ref || !project) return null;
  switch (ref.kind) {
    case "chat":
      return <ConversationView agentId={project.orchestrator_agent_id} tab={tab} />;
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
    case "tool":
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
            {ref.tool === "agents" ? <AgentsPanel /> : ref.tool === "notes" ? <NotesPanel /> : ref.tool === "usage" ? <UsagePanel /> : <DetailsPanel />}
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

function SessionTab({ sessionId, tab }: { sessionId: string; tab: TabId }) {
  const ws = useOptionalWorkspace();
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
          {floating && <FloatingComposer onHeight={setHeight} />}
        </div>
      </FloatRoomContext.Provider>
    </FloatingBlockContext.Provider>
  );
}
