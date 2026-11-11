import { useState } from "react";
import type { HitTarget } from "../../lib/memory/search";
import { useApp } from "../../state/app";
import { Segmented } from "../primitives/Segmented";
import { ContextTab } from "./ContextTab";
import { FilesTab } from "./FilesTab";
import { Empty } from "./parts";
import { SearchTab } from "./SearchTab";
import { TasksTab } from "./TasksTab";
import { useMemoryFiles, useTasks } from "./useMemory";

export type MemoryTab = "tasks" | "files" | "search" | "context";

const TABS: readonly { id: MemoryTab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "files", label: "Files" },
  { id: "search", label: "Search" },
  { id: "context", label: "Context" },
];

/**
 * What the orchestrator remembers about a project (orchestrator memory M3): its task records, memory files, a search
 * over all of it, and per request the context receipt (what it had in front of it). It fills the space it is given
 * (a dock tab or a page) and sizes itself by container width: list and detail side by side from 640px, one column below.
 * Hosts pass `onOpenMessage` (open a request in the chat) and `onOpenFile` (open a project file); without them the
 * links are plain text. Needs a bridge with the memory methods, and says so when it has none.
 */
export function MemoryView(props: {
  projectId: string;
  onOpenMessage?: (messageId: number) => void;
  onOpenFile?: (path: string) => void;
  /** Opens on this tab (default Tasks). */
  initialTab?: MemoryTab;
  /** With the Context tab: the request whose receipt is shown first. */
  turnId?: number;
}) {
  const { bridge } = useApp();
  const { projectId, onOpenMessage, onOpenFile } = props;
  const [tab, setTab] = useState<MemoryTab>(props.initialTab ?? (props.turnId !== undefined ? "context" : "tasks"));
  const [task, setTask] = useState<{ id: string | null; fact: string | null }>({ id: null, fact: null });
  const [file, setFile] = useState<string | null>(null);
  const [turn, setTurn] = useState<number | null>(props.turnId ?? null);
  const tasks = useTasks(projectId);
  const files = useMemoryFiles(projectId);

  if (!bridge.listTasks && !bridge.listMemory) {
    return <Empty title="This harness has no memory">Update the harness to see task records, memory files and context receipts here.</Empty>;
  }

  const open = (t: NonNullable<HitTarget>) => {
    if (t.to === "task") {
      setTask({ id: t.taskId, fact: t.factId });
      setTab("tasks");
    } else if (t.to === "file") {
      setFile(t.path);
      setTab("files");
    } else onOpenMessage?.(t.messageId);
  };
  const canOpenMessage = onOpenMessage !== undefined;

  return (
    <div className="@container/memory flex h-full min-h-0 flex-col pt-pane" data-memory>
      <div className="flex h-row shrink-0 items-center overflow-x-auto px-pane">
        <Segmented<MemoryTab> label="Memory" options={TABS} value={tab} onChange={setTab} />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "tasks" && (
          <TasksTab
            load={tasks.load}
            reload={tasks.reload}
            selected={task.id}
            focusFact={task.fact}
            onSelect={(id, fact) => setTask({ id, fact: fact ?? null })}
            onOpenMessage={onOpenMessage}
            onOpenFile={onOpenFile}
          />
        )}
        {tab === "files" && <FilesTab projectId={projectId} load={files.load} reload={files.reload} selected={file} onSelect={setFile} />}
        {tab === "search" && <SearchTab projectId={projectId} onOpen={open} canOpenMessage={canOpenMessage} />}
        {tab === "context" && <ContextTab projectId={projectId} selected={turn} onSelect={setTurn} onOpen={open} canOpenMessage={canOpenMessage} />}
      </div>
    </div>
  );
}
