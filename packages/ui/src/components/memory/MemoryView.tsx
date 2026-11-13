import { useRef, useState, type KeyboardEvent } from "react";
import type { HitTarget } from "../../lib/memory/search";
import { useApp } from "../../state/app";
import { Panel, PanelFilters } from "../primitives/Panel";
import { SearchField } from "../primitives/SearchField";
import { ViewTabs } from "../primitives/ViewTabs";
import { FilesView } from "./FilesView";
import { PaneEmpty } from "./parts";
import { KnowledgeView, type KnowledgeFocus } from "./KnowledgeView";
import { SearchResults } from "./SearchResults";
import { SessionsView } from "./SessionsView";
import { useMemorySearch } from "./useMemorySearch";
import { useMemoryFiles, useTasks } from "./useMemory";

export type MemoryTab = "sessions" | "knowledge" | "files";

const TABS: readonly { id: MemoryTab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "knowledge", label: "Knowledge" },
  { id: "files", label: "Files" },
];

/**
 * What the orchestrator remembers about a project (decision 93): one search field above three views, Sessions (what was
 * asked and answered), Knowledge (what is remembered, and the tasks) and Files. While the field has text its results
 * replace the views, grouped by kind; Esc clears it. It fills the space it is given and sizes itself by container width:
 * list and detail side by side from 640 px, one column below, where rows open in place. Hosts pass `onOpenMessage` (a
 * request in the chat), `onOpenFile` (a project file) and `onOpenNote`; without them those links are plain text or absent.
 */
export function MemoryView(props: {
  projectId: string;
  onOpenMessage?: ((messageId: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenNote?: ((noteId: string) => void) | undefined;
  initialView?: MemoryTab;
}) {
  const { bridge } = useApp();
  const { projectId, onOpenMessage, onOpenFile, onOpenNote } = props;
  const [view, setView] = useState<MemoryTab>(props.initialView ?? "sessions");
  const [query, setQuery] = useState("");
  const [session, setSession] = useState<{ id: string | null; exchange: string | null }>({ id: null, exchange: null });
  const [focus, setFocus] = useState<KnowledgeFocus & { nonce: number }>({ task: null, fact: null, nonce: 0 });
  const [file, setFile] = useState<string | null>(null);
  const tasks = useTasks(projectId);
  const files = useMemoryFiles(projectId);
  const search = useMemorySearch(projectId, query);
  const field = useRef<HTMLInputElement>(null);
  const searching = query.trim() !== "";

  if (!bridge.listTasks && !bridge.listMemory && !bridge.listMemorySessions) {
    return <PaneEmpty title="This harness has no memory">Update the harness to see sessions, what is remembered and memory files here.</PaneEmpty>;
  }

  const open = (t: HitTarget) => {
    setQuery("");
    if (t.to === "task") {
      setFocus((f) => ({ task: t.factId ? null : t.taskId, fact: t.factId ? `${t.taskId}/${t.factId}` : null, nonce: f.nonce + 1 }));
      setView("knowledge");
    } else if (t.to === "file") {
      setFile(t.path);
      setView("files");
    } else if (t.to === "session") {
      setSession({ id: t.sessionId, exchange: t.exchangeId });
      setView("sessions");
    } else if (t.to === "message") onOpenMessage?.(t.messageId);
    else onOpenNote?.(t.noteId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      field.current?.focus();
      field.current?.select();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Ctrl/Cmd+F while the tab has focus goes to its search field (decision 93 b)
    <div className="h-full min-h-0" data-memory onKeyDown={onKeyDown}>
      <Panel
        name="memory"
        title="Memory"
        filters={
          <PanelFilters>
            <SearchField
              ref={field}
              label="Search memory"
              placeholder="Search exchanges, knowledge, files and notes"
              size="sm"
              value={query}
              onChange={setQuery}
              className="min-w-0 flex-1"
            />
          </PanelFilters>
        }
        views={searching ? <div className="border-b border-line" /> : <ViewTabs<MemoryTab> label="Memory" options={TABS} value={view} onChange={setView} />}
      >
        {searching ? (
          <SearchResults state={search} query={query} canOpenMessage={onOpenMessage !== undefined} onOpen={open} />
        ) : (
          <div className="h-full min-h-0">
            {view === "sessions" && (
              <SessionsView
                projectId={projectId}
                selected={session.id}
                focusExchange={session.exchange}
                onSelect={(id) => setSession({ id, exchange: null })}
                onOpenMessage={onOpenMessage}
              />
            )}
            {view === "knowledge" && (
              <KnowledgeView key={focus.nonce} load={tasks.load} reload={tasks.reload} focus={focus} onOpenMessage={onOpenMessage} onOpenFile={onOpenFile} />
            )}
            {view === "files" && <FilesView projectId={projectId} load={files.load} reload={files.reload} selected={file} onSelect={setFile} />}
          </div>
        )}
      </Panel>
    </div>
  );
}
