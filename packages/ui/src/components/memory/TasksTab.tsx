import type { Task, TaskStatus } from "@octo/agent-client";
import { CircleCheck, CircleDashed, Circle } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import type { Load } from "../../lib/memory/load";
import { factRows, filterCounts, filterTasks, formatDay, goalNote, STATUS_LABEL, TASK_FILTERS, type FactRow, type TaskFilter } from "../../lib/memory/tasks";
import { Glyph } from "../primitives/Glyph";
import { FilterTabs } from "../primitives/FilterTabs";
import { Block, DetailTitle, Empty, ErrorState, ListDetail, ListRow, Loading, RowList } from "./parts";

const STATUS_ICON = { open: Circle, done: CircleCheck, dropped: CircleDashed } as const;
const STATUS_TONE: Record<TaskStatus, string> = { open: "text-fg-3", done: "text-ok", dropped: "text-fg-3" };

export function StatusMark({ status }: { status: TaskStatus }) {
  return (
    <span className={cn("flex items-center", STATUS_TONE[status])} title={STATUS_LABEL[status]}>
      <Glyph icon={STATUS_ICON[status]} size={14} />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Tasks: the status filter over a list of records; the detail is the whole record. */
export function TasksTab(props: {
  load: Load<Task[]>;
  reload(): void;
  selected: string | null;
  focusFact: string | null;
  onSelect(id: string | null, fact?: string): void;
  onOpenMessage?: ((id: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const tasks = props.load.status === "ok" ? props.load.value : null;
  const counts = useMemo(() => (tasks ? filterCounts(tasks) : null), [tasks]);
  const shown = useMemo(() => (tasks ? filterTasks(tasks, filter) : []), [tasks, filter]);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const current = tasks?.find((t) => t.id === props.selected) ?? null;

  if (props.load.status === "loading") return <Loading />;
  if (props.load.status === "error") return <ErrorState message={props.load.message} onRetry={props.reload} />;
  if (!tasks || tasks.length === 0) {
    return <Empty title="No tasks yet">Each request opens a task record. Its goal, decisions and facts are filled in as the work goes on.</Empty>;
  }
  return (
    <ListDetail
      label="Tasks"
      listLabel="Tasks"
      placeholder="Choose a task to see its goal, decisions and facts."
      onBack={() => props.onSelect(null)}
      listHeader={
        <FilterTabs<TaskFilter>
          label="Task status"
          options={TASK_FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts?.[f.id] ?? 0 }))}
          value={filter}
          onChange={setFilter}
        />
      }
      list={
        shown.length === 0 ? (
          <p className="px-2 py-3 text-sm text-fg-3">No {filter === "all" ? "" : `${STATUS_LABEL[filter].toLowerCase()} `}tasks.</p>
        ) : (
          <RowList label="Tasks">
            {shown.map((t) => (
              <ListRow
                key={t.id}
                selected={t.id === props.selected}
                onClick={() => props.onSelect(t.id)}
                leading={<StatusMark status={t.status} />}
                label={t.title}
                trailing={formatRelative(t.updated_at, now)}
                title={t.title}
              />
            ))}
          </RowList>
        )
      }
      detail={
        current ? (
          <TaskDetail
            task={current}
            all={tasks}
            focusFact={props.focusFact}
            onSelect={props.onSelect}
            onOpenMessage={props.onOpenMessage}
            onOpenFile={props.onOpenFile}
            now={now}
          />
        ) : null
      }
    />
  );
}

function TaskDetail(props: {
  task: Task;
  all: Task[];
  focusFact: string | null;
  onSelect(id: string | null, fact?: string): void;
  onOpenMessage: ((id: number) => void) | undefined;
  onOpenFile: ((path: string) => void) | undefined;
  now: number;
}) {
  const { task, now } = props;
  const uid = useId();
  const rows = useMemo(() => factRows(task, props.all), [task, props.all]);
  const note = goalNote(task);
  const list = (title: string, items: string[], id: string) =>
    items.length > 0 && (
      <Block title={title} id={`${uid}-${id}`}>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-fg marker:text-fg-3">
          {items.map((t, i) => (
            <li key={i} className="break-words">
              {t}
            </li>
          ))}
        </ul>
      </Block>
    );
  return (
    <article aria-label={task.title}>
      <DetailTitle title={task.title}>
        <span className="flex items-center gap-1.5">
          <StatusMark status={task.status} />
          {STATUS_LABEL[task.status]}
        </span>
        <span>Updated {formatDay(task.updated_at, now)}</span>
        <span className="font-mono">{task.id}</span>
      </DetailTitle>
      <Block title="Goal" id={`${uid}-goal`} aside={note ? <span>{note}</span> : undefined}>
        <p className="text-sm break-words whitespace-pre-wrap text-fg">{task.goal || "Not written yet"}</p>
      </Block>
      {list("Constraints", task.constraints, "constraints")}
      {list("Acceptance", task.acceptance, "acceptance")}
      {task.quotes.length > 0 && (
        <Block title="What was asked, in your words" id={`${uid}-quotes`}>
          <ul className="flex flex-col gap-2">
            {task.quotes.map((q, i) => (
              <li key={i} className="border-l-2 border-line-strong pl-3 text-sm">
                <q className="break-words text-fg">{q.text}</q>
                <div className="mt-0.5 text-xs text-fg-3">
                  {props.onOpenMessage ? (
                    <button
                      type="button"
                      onClick={() => props.onOpenMessage?.(q.message_id)}
                      className="rounded-xs text-link underline-offset-2 focus-inset hover:underline"
                    >
                      Open the request
                    </button>
                  ) : (
                    <span>Request {q.message_id}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {list("Decisions", task.decisions, "decisions")}
      {rows.length > 0 && (
        <Block title={`Facts, ${rows.length}`} id={`${uid}-facts`}>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <FactItem key={r.fact.id} row={r} focus={props.focusFact === r.fact.id} onSelect={props.onSelect} taskId={task.id} now={now} />
            ))}
          </ul>
        </Block>
      )}
      {task.outcome && (
        <Block title="Outcome" id={`${uid}-outcome`}>
          <p className="text-sm break-words whitespace-pre-wrap text-fg">{task.outcome}</p>
        </Block>
      )}
      {task.files.length > 0 && (
        <Block title="Files" id={`${uid}-files`}>
          <ul className="flex flex-col">
            {task.files.map((f) => (
              <li key={f} className="min-w-0">
                {props.onOpenFile ? (
                  <button
                    type="button"
                    onClick={() => props.onOpenFile?.(f)}
                    className="block h-row max-w-full truncate rounded-sm px-2 text-left font-mono text-xs text-fg-2 focus-inset hover:bg-hover hover:text-fg"
                  >
                    {f}
                  </button>
                ) : (
                  <span className="block h-row truncate px-2 font-mono text-xs leading-7 text-fg-2">{f}</span>
                )}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </article>
  );
}

function FactItem(props: { row: FactRow; focus: boolean; taskId: string; now: number; onSelect(id: string | null, fact?: string): void }) {
  const { fact, superseded, by, byTask } = props.row;
  return (
    <li
      id={`fact-${props.taskId}-${fact.id}`}
      ref={(el) => {
        if (props.focus) el?.scrollIntoView({ block: "center" });
      }}
      className={cn("flex gap-3 rounded-sm text-sm", props.focus && "bg-hover")}
    >
      <time dateTime={fact.date} className="w-14 shrink-0 text-xs leading-5 text-fg-3">
        {formatDay(fact.date, props.now)}
      </time>
      <div className="min-w-0 flex-1">
        {superseded ? (
          <del className="break-words text-fg-3">
            <span className="sr-only">Superseded: </span>
            {fact.text}
          </del>
        ) : (
          <p className="break-words text-fg">{fact.text}</p>
        )}
        {superseded && (
          <p className="mt-0.5 text-xs text-fg-3">
            {by ? (
              <>
                Replaced by{" "}
                <button
                  type="button"
                  onClick={() =>
                    byTask ? props.onSelect(byTask.id, by.id) : document.getElementById(`fact-${props.taskId}-${by.id}`)?.scrollIntoView({ block: "center" })
                  }
                  className="rounded-xs text-link underline-offset-2 focus-inset hover:underline"
                >
                  {byTask ? `a fact in “${byTask.title}”` : `“${by.text.length > 60 ? `${by.text.slice(0, 59)}…` : by.text}”`}
                </button>
              </>
            ) : (
              "Replaced by a newer fact"
            )}
          </p>
        )}
      </div>
    </li>
  );
}
