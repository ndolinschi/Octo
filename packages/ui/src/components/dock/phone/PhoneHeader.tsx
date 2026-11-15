import { ArrowLeft, Ellipsis, Menu as MenuIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useOptionalComments } from "../../../state/comments";
import { useCode } from "../../../state/code";
import { useProject } from "../../../state/project";
import { useShell } from "../../../state/shell";
import { allTabs, focusedGroup, parseTab } from "../../../state/workspace/layout";
import { useWorkspace } from "../../../state/workspace/WorkspaceProvider";
import { sessionGlyph } from "../../../lib/sessions/tree";
import type { FileKey } from "../../../lib/files";
import { IconButton } from "../../primitives/IconButton";
import { Presence } from "../../primitives/Presence";
import { StateGlyph } from "../../primitives/StateGlyph";
import { tabInfo } from "../tabInfo";
import { conversationSession, isConversation, reopenFor, usePanelHistory } from "./panelHistory";

const PhoneMoreSheet = lazy(() => import("./PhoneMoreSheet"));

/**
 * The phone layout's header (direction 7), in place of the tab strips (`ProjectWorkspace` mounts it above the dock; the strips
 * are hidden): one line, 44px under the top safe-area inset.
 * - A conversation: the menu (the full-screen navigation), the session's title in full (cut at its end only when it must)
 *   over the project's name, the session's state as a glyph (working, needs you, queued, failed), and "⋯" (the sheet with
 *   the tabs, commands, panels, status and settings: `PhoneMoreSheet`).
 * - Anything else (a panel, a file, a run, a helper's transcript) is a full screen of its own: Back (the system's Back does
 *   the same: `usePanelHistory`), its name, and "⋯".
 */
export default function PhoneHeader() {
  const ws = useWorkspace();
  // One strip for everything on the phone: the focused group's tab is the screen, every tab is in "⋯".
  const props = { active: focusedGroup(ws.layout).active, tabs: allTabs(ws.layout) };
  const code = useCode();
  const { state, project, projectId } = useProject();
  const { toggleSidebar, sidebarOpen } = useShell();
  const counts = useOptionalComments()?.counts;
  const [more, setMore] = useState(false);
  const conversation = isConversation(props.active, state);
  usePanelHistory(projectId, props.active, conversation, (tab) => {
    const r = reopenFor(tab, props.tabs);
    if (r.kind === "activate") ws.activate(r.tab);
    else if (r.kind === "tool") ws.openTool(r.tool);
    else if (r.kind === "file") ws.openFileTab(r.key);
    else if (r.kind === "run") ws.openRun(r.name);
    else if (r.kind === "agent") ws.openAgent(r.agentId);
    else if (r.kind === "session") ws.openSession(r.sessionId);
    else ws.focusChat();
  });
  const info = tabInfo(props.active, {
    state,
    projectName: project?.name,
    orchestratorId: project?.orchestrator_agent_id,
    chatSessionId: ws.chatSessionId,
    file: code.file,
    comments: (key: FileKey) => counts?.get(key) ?? 0,
    runStatus: (name: string) => ws.runStatuses[name.toLowerCase()] ?? null,
  });
  const sid = conversationSession(props.active, ws.chatSessionId, state);
  const session = sid !== null ? state.sessions.list.find((s) => s.id === sid) : undefined;
  const glyph = session ? sessionGlyph(session) : info.glyph;
  const projectName = project?.name ?? "";
  const full = info.name ?? info.label;
  // A conversation's name is "Project / topic": the topic is the title, the project the meta line.
  const title = conversation ? (full.startsWith(`${projectName} / `) ? full.slice(projectName.length + 3) : session?.title.trim() || full) : full;
  const ref = parseTab(props.active);
  const meta = conversation ? (title === projectName ? null : projectName) : ref?.kind === "file" ? info.title : null;
  return (
    <header aria-label="Session" data-phone-header className="octo-phone-header flex shrink-0 items-center gap-1 px-1">
      {conversation ? (
        <IconButton icon={MenuIcon} label="Menu" size="lg" aria-expanded={sidebarOpen} onClick={toggleSidebar} />
      ) : (
        <IconButton icon={ArrowLeft} label="Back" size="lg" onClick={() => window.history.back()} />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <h1 data-phone-title data-page-title tabIndex={-1} className="truncate text-title text-fg focus-visible:shadow-none">
          {title}
        </h1>
        {meta && <p className="truncate text-xs text-fg-3">{meta}</p>}
      </div>
      {glyph && glyph !== "idle" && (
        <span data-phone-state className="grid size-ctl-lg shrink-0 place-items-center">
          <StateGlyph state={glyph} size={14} box={16} label />
        </span>
      )}
      <IconButton icon={Ellipsis} label="More" size="lg" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)} />
      <Presence show={more}>
        <Suspense fallback={null}>
          <PhoneMoreSheet active={props.active} tabs={props.tabs} sessionId={sid} onClose={() => setMore(false)} />
        </Suspense>
      </Presence>
    </header>
  );
}
