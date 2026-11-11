import { Clock, FileText, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "../primitives/Glyph";
import { sizeLabel, type Attachment } from "./attachments";

/** The pill shape shared by attachments, comments and queued messages (exported for CommentsControl's pill variant). */
export const PILL = "flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-hover pl-2 text-sm text-fg-2";

function Pill({
  icon,
  label,
  detail,
  title,
  onRemove,
  removeLabel,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  title: string;
  onRemove(): void;
  removeLabel: string;
}) {
  return (
    <li className={cn(PILL, "pr-0.5")} title={title}>
      <Glyph icon={icon} size={14} className="shrink-0 text-fg-3" />
      <span className="min-w-0 truncate text-fg">{label}</span>
      {detail && <span className="shrink-0 text-xs text-fg-3 tabular-nums">{detail}</span>}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="grid size-6 shrink-0 press place-items-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg"
      >
        <Glyph icon={X} size={14} />
      </button>
    </li>
  );
}

export type QueuedMessage = { id: string; text: string };

/**
 * The composer's top band (decision 62): queued messages, pending line comments (one pill, its popover lists them)
 * and attached files, as removable pills. Renders nothing when there is nothing to show.
 */
export function ComposerPills(props: {
  files: Attachment[];
  onRemoveFile(id: string): void;
  comments: ReactNode;
  queue: QueuedMessage[];
  onUnqueue(id: string): void;
}) {
  if (!props.files.length && !props.comments && !props.queue.length) return null;
  return (
    <ul aria-label="Attached to your next message" className="flex flex-wrap gap-1.5 px-2 pt-2">
      {props.queue.map((q) => (
        <Pill
          key={q.id}
          icon={Clock}
          label={q.text.split("\n", 1)[0] ?? ""}
          detail="queued"
          title={`Sent when the current turn ends:\n${q.text}`}
          removeLabel="Remove from the queue"
          onRemove={() => props.onUnqueue(q.id)}
        />
      ))}
      {props.comments && <li className="flex min-w-0">{props.comments}</li>}
      {props.files.map((f) => (
        <Pill
          key={f.id}
          icon={FileText}
          label={f.name}
          detail={sizeLabel(f.size)}
          title={f.name}
          removeLabel={`Remove ${f.name}`}
          onRemove={() => props.onRemoveFile(f.id)}
        />
      ))}
    </ul>
  );
}
