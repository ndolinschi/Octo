import { Clock, FileText, X, type LucideIcon } from "lucide-react";
import { IconButton } from "../primitives/IconButton";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "../primitives/Glyph";
import { sizeLabel } from "./attachmentRules";
import type { Attachment } from "./attachments";
import { imageSize } from "../../lib/imagePlan";
import { Spinner } from "../primitives/Status";
import type { ImageChip } from "./useImages";

/** The pill shape shared by attachments, comments and queued messages (exported for CommentsControl's pill variant). */
export const PILL = "flex min-h-7 max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-hover pl-2 text-sm text-fg-2 phone:min-h-ctl-lg";

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
      <IconButton icon={X} size="xs" label={removeLabel} onClick={onRemove} />
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
  images?: ImageChip[];
  onRemoveImage?(id: string): void;
  comments: ReactNode;
  queue: QueuedMessage[];
  onUnqueue(id: string): void;
}) {
  const images = props.images ?? [];
  if (!props.files.length && !props.comments && !props.queue.length && !images.length) return null;
  return (
    <ul aria-label="Attached to your next message" className="flex flex-wrap gap-1.5 px-3 pt-2">
      {props.queue.map((q) => (
        <Pill
          key={q.id}
          icon={Clock}
          label={q.text.split("\n", 1)[0] ?? ""}
          detail="queued"
          title={`Sends after the current reply:\n${q.text}`}
          removeLabel="Remove from the queue"
          onRemove={() => props.onUnqueue(q.id)}
        />
      ))}
      {props.comments && <li className="flex min-w-0">{props.comments}</li>}
      {images.map((img) => (
        <li key={img.id} data-image-chip={img.state} className={cn(PILL, "pr-0.5 pl-1")} title={img.problem ?? img.name}>
          {img.state === "working" ? (
            <span className="grid size-5 place-items-center">
              <Spinner />
            </span>
          ) : (
            <img src={img.url} alt="" className="size-5 shrink-0 rounded-xs object-cover" />
          )}
          <span className="min-w-0 truncate text-fg">{img.name}</span>
          <span className={cn("shrink-0 text-xs tabular-nums", img.state === "failed" ? "text-err" : "text-fg-3")}>
            {img.state === "failed" ? "not attached" : imageSize(img.bytes)}
          </span>
          <IconButton icon={X} size="xs" label={`Remove ${img.name}`} onClick={() => props.onRemoveImage?.(img.id)} />
        </li>
      ))}
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
