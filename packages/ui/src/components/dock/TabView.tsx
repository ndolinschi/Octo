import { lazy, Suspense, useState } from "react";
import { FileViewSkeleton } from "../files/EditorSkeleton";
import { useProject } from "../../state/project";
import { FloatRoomContext } from "../primitives/floatRoom";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { useFloatingHere } from "../../state/workspace/useFloatingHere";
import { ConversationView } from "../chat/ConversationView";
import { FloatingComposer } from "../chat/FloatingComposer";
import type { FloatingSlot } from "../files/FileView";

/** The file view (breadcrumbs, tree column, editor host) loads with the first file or Files tab: its own chunk. */
const FileView = lazy(() => import("../files/FileView").then((m) => ({ default: m.FileView })));

/** What a file view renders as its floating composer: the dock, not the file feature, knows about chat. */
const renderFloatingComposer: FloatingSlot = (onHeight) => <FloatingComposer onHeight={onHeight} />;

/** The Details tab loads when it is first opened (its own chunk). */
const DetailsPanel = lazy(() => import("../details/DetailsPanel").then((m) => ({ default: m.DetailsPanel })));
/** Agents and Notes load when first opened too (their own chunks). */
const AgentsPanel = lazy(() => import("../agents/AgentsPanel").then((m) => ({ default: m.AgentsPanel })));
const NotesPanel = lazy(() => import("../notes/NotesPanel").then((m) => ({ default: m.NotesPanel })));
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
      return (
        <ToolView tab={tab}>
          <Suspense fallback={null}>
            {ref.tool === "agents" ? <AgentsPanel /> : ref.tool === "notes" ? <NotesPanel /> : ref.tool === "usage" ? <UsagePanel /> : <DetailsPanel />}
          </Suspense>
        </ToolView>
      );
  }
}

/**
 * Agents, Notes, Details and Usage: the floating composer sits over them too when no Chat tab is visible, and
 * their lists reserve its height + 16 at the end (`FloatRoom`, the editor's rule), so the last row can
 * always be scrolled above it.
 */
function ToolView({ tab, children }: { tab: TabId; children: React.ReactNode }) {
  const floating = useFloatingHere(tab);
  const [height, setHeight] = useState(0);
  const room = floating && height > 0 ? height + 16 : 0;
  return (
    <FloatRoomContext.Provider value={room}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {floating && <FloatingComposer onHeight={setHeight} />}
      </div>
    </FloatRoomContext.Provider>
  );
}
