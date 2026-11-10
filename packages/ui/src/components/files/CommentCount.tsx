import { MessageSquare } from "lucide-react";

/** "2 pending comments": the description for a file's tab or tree row (its name stays the file name). */
export function commentsDescription(count: number): string | undefined {
  return count > 0 ? `${count} pending ${count === 1 ? "comment" : "comments"}` : undefined;
}

/** Small visual marker on file tabs and tree rows: this file has pending code comments (announced via `aria-description`). */
export function CommentCount({ count }: { count: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5 text-xs text-fg-3 tabular-nums">
      <MessageSquare size={11} strokeWidth={1.5} absoluteStrokeWidth />
      {count}
    </span>
  );
}
