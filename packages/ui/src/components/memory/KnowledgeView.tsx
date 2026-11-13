import type { Task, TaskStatus } from "@octo/agent-client";
import { useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { moveInList } from "../../lib/focus";
import { useNow } from "../../lib/hooks";
import type { Load } from "../../lib/memory/load";
import { filterCounts, rememberedItems, TASK_FILTERS } from "../../lib/memory/tasks";
import { useApp } from "../../state/app";
import { FilterTabs } from "../primitives/FilterTabs";
import { PanelFilters } from "../primitives/Panel";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { Button } from "../primitives/Button";
import { FloatRoom } from "../primitives/floatRoom";
import { DETAIL_MAX, MemoryError, PaneEmpty } from "./parts";
import { AddFact, RememberedHeader, RememberedList } from "./Remembered";
import { TaskList } from "./TaskList";

/** What a search hit asks Knowledge to show: a task, or one remembered item (`taskId/factId`). */
export type KnowledgeFocus = { task: string | null; fact: string | null };

/**
 * Knowledge (decision 93 e): what the project remembers (items, newest first, with who kept each and when) and its
 * tasks (Open, Done, Dropped). One column at every width; rows open in place.
 */
export function KnowledgeView(props: {
  load: Load<Task[]>;
  reload(): void;
  focus: KnowledgeFocus;
  onOpenMessage?: ((id: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { bridge } = useApp();
  const now = useNow(false, CLOCK_MINUTE_MS);
  const tasks = props.load.status === "ok" ? props.load.value : null;
  const items = useMemo(() => (tasks ? rememberedItems(tasks) : []), [tasks]);
  const counts = useMemo(() => (tasks ? filterCounts(tasks) : null), [tasks]);
  const [adding, setAdding] = useState(false);
  const focusTask = tasks?.find((t) => t.id === props.focus.task) ?? null;
  const [status, setStatus] = useState<TaskStatus>(focusTask?.status ?? "open");

  if (props.load.status === "error") return <MemoryError message={props.load.message} onRetry={props.reload} />;
  if (props.load.status === "loading") return <SkeletonList count={6} size="md" twoLine />;
  const canAdd = bridge.rememberFact !== undefined;
  if (tasks?.length === 0 && items.length === 0 && !adding) {
    return (
      <PaneEmpty
        title="Nothing remembered yet"
        {...(canAdd
          ? {
              actions: (
                <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                  Remember something
                </Button>
              ),
            }
          : {})}
      >
        Decisions, preferences and facts the orchestrator keeps appear here, with the tasks they belong to.
      </PaneEmpty>
    );
  }
  return (
    <ScrollArea className="h-full min-h-0 px-pane pt-1 pb-6">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- ↑/↓/Home/End between the rows of both lists */}
      <div onKeyDown={moveInList} className={DETAIL_MAX}>
        <section aria-label="Remembered">
          <RememberedHeader count={items.length} onAdd={canAdd && !adding ? () => setAdding(true) : undefined} />
          {adding && <AddFact onDone={() => setAdding(false)} onKept={props.reload} />}
          {items.length === 0 && !adding ? (
            <p className="px-2 py-3 text-sm text-fg-3">Nothing yet. Add what every request should know.</p>
          ) : (
            <RememberedList items={items} now={now} focus={props.focus.fact} onOpenMessage={props.onOpenMessage} onForgotten={props.reload} />
          )}
        </section>
        <section aria-label="Tasks" className="pt-4">
          <SectionHeader inset>Tasks</SectionHeader>
          <PanelFilters flush>
            <FilterTabs<TaskStatus>
              bare
              label="Task status"
              options={TASK_FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts?.[f.id] ?? 0 }))}
              value={status}
              onChange={setStatus}
            />
          </PanelFilters>
          <TaskList
            // Another status is another list: its open row and fold start over.
            key={status}
            tasks={tasks ?? []}
            status={status}
            now={now}
            focus={props.focus.task}
            onOpenMessage={props.onOpenMessage}
            onOpenFile={props.onOpenFile}
          />
        </section>
      </div>
      <FloatRoom />
    </ScrollArea>
  );
}
