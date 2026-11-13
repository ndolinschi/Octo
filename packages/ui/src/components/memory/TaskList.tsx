import type { Task, TaskStatus } from "@octo/agent-client";
import { CircleCheck, CircleDashed, Circle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { filterTasks, fold, STATUS_LABEL, taskDescription } from "../../lib/memory/tasks";
import { Button } from "../primitives/Button";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { Expansion, ROW_TAIL, RowLine, useCollapseOnEscape, useReveal } from "./parts";

const STATUS_ICON = { open: Circle, done: CircleCheck, dropped: CircleDashed } as const;

function StatusGlyph({ status }: { status: TaskStatus }) {
  // A state glyph: the only coloured thing in the list, and only for a finished task.
  return <Glyph icon={STATUS_ICON[status]} size={14} className={cn(status === "done" && "text-ok")} />;
}

/** The rows of one status: a task's goal, then what it was told to keep to, and how it ended. Folded after eight. */
export function TaskList(props: {
  tasks: Task[];
  status: TaskStatus;
  now: number;
  /** A task to open and scroll to (a search hit). */
  focus: string | null;
  onOpenMessage?: ((id: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const shown = filterTasks(props.tasks, props.status);
  const at = shown.findIndex((t) => t.id === props.focus);
  const [open, setOpen] = useState<string | null>(at >= 0 ? props.focus : null);
  const [unfolded, setUnfolded] = useState(at >= 8);
  const rows = fold(shown, unfolded);
  if (shown.length === 0) return <p className="px-2 py-3 text-sm text-fg-3">No {STATUS_LABEL[props.status].toLowerCase()} tasks.</p>;
  return (
    <>
      <ul aria-label="Tasks" className="flex flex-col">
        {rows.shown.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            now={props.now}
            open={open === t.id}
            reveal={t.id === props.focus}
            onToggle={() => setOpen((cur) => (cur === t.id ? null : t.id))}
            onClose={() => setOpen(null)}
            onOpenMessage={props.onOpenMessage}
            onOpenFile={props.onOpenFile}
          />
        ))}
      </ul>
      {rows.hidden > 0 && <ListRow size="md" tone="quiet" title={`Show ${rows.hidden} more`} onClick={() => setUnfolded(true)} />}
    </>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col">
      <SectionHeader as="h4">{title}</SectionHeader>
      {children}
    </section>
  );
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-fg marker:text-fg-3">
    {items.map((t, i) => (
      <li key={i} className="break-words">
        {t}
      </li>
    ))}
  </ul>
);

function TaskRow(props: {
  task: Task;
  now: number;
  open: boolean;
  reveal: boolean;
  onToggle(): void;
  onClose(): void;
  onOpenMessage?: ((id: number) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const t = props.task;
  const { box, onKeyDown } = useCollapseOnEscape(props.open, props.onClose);
  useReveal(box, props.reveal);
  const openFile = props.onOpenFile;
  const openMessage = props.onOpenMessage;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the open row from anywhere inside it
    <li ref={box} onKeyDown={onKeyDown} className={cn(props.open && "mb-1 rounded-sm bg-active")}>
      <ListRow
        size="md"
        expanded={props.open}
        leading={<StatusGlyph status={t.status} />}
        title={
          <>
            <span className="sr-only">{STATUS_LABEL[t.status]}: </span>
            {t.title}
          </>
        }
        description={<RowLine end={formatRelative(t.updated_at, props.now)}>{taskDescription(t)}</RowLine>}
        tip={t.title}
        onClick={props.onToggle}
        trailing={ROW_TAIL}
      />
      {props.open && (
        <Expansion>
          {t.goal && (
            <Part title="Goal">
              <p className="text-sm break-words whitespace-pre-wrap text-fg">{t.goal}</p>
            </Part>
          )}
          {t.constraints.length > 0 && (
            <Part title="Constraints">
              <Bullets items={t.constraints} />
            </Part>
          )}
          {t.acceptance.length > 0 && (
            <Part title="Done when">
              <Bullets items={t.acceptance} />
            </Part>
          )}
          {t.decisions.length > 0 && (
            <Part title="Decisions">
              <Bullets items={t.decisions} />
            </Part>
          )}
          {t.outcome && (
            <Part title="Outcome">
              <p className="text-sm break-words whitespace-pre-wrap text-fg">{t.outcome}</p>
            </Part>
          )}
          {t.quotes.length > 0 && (
            <Part title="Asked">
              <ul className="flex flex-col gap-2">
                {t.quotes.map((q, i) => (
                  <li key={i} className="border-l-2 border-line-strong pl-3 text-sm">
                    <q className="break-words text-fg-2">{q.text}</q>
                    {openMessage && (
                      <div className="pt-0.5">
                        <Button variant="link" size="xs" tone="quiet" onClick={() => openMessage(q.message_id)}>
                          Open the request
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Part>
          )}
          {t.files.length > 0 && (
            <Part title="Files">
              <div className="-mx-2 flex flex-col">
                {t.files.map((f) => (
                  <ListRow
                    key={f}
                    leading={<Glyph icon={fileIcon(f)} size={14} />}
                    title={f}
                    truncate="middle"
                    tone="quiet"
                    tip={f}
                    {...(openFile ? { onClick: () => openFile(f) } : {})}
                  />
                ))}
              </div>
            </Part>
          )}
        </Expansion>
      )}
    </li>
  );
}
