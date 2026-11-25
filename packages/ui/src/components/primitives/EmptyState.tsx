import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Decision 64 (h): every empty panel is one composed block, never a sentence at the top of an empty page. The block is
 * centred horizontally and its centre sits at about 42% of the free height (the spacers split the room 42 : 58), above any
 * input that is below it (the parent keeps the input outside this box). A short title, one line of explanation, then the
 * starting actions directly under them, all on one centred axis; nothing floats beside the sentence.
 *
 * Put it as a direct child of a flex column that owns the panel's height; in any other parent it is just the block.
 */
export function EmptyState(props: {
  title: string;
  /** One line. */
  children?: ReactNode;
  /** The suggestions or buttons, under the sentence. */
  actions?: ReactNode;
  tone?: "plain" | "err";
  className?: string;
}) {
  return (
    <div data-empty-state className={cn("flex min-h-0 flex-1 flex-col", props.className)}>
      <div aria-hidden className="flex-[42]" />
      <div className="mx-auto flex w-full max-w-sm shrink-0 flex-col items-center gap-2 px-4 text-center">
        <p role={props.tone === "err" ? "alert" : undefined} className={cn("text-heading text-balance", props.tone === "err" ? "text-err" : "text-fg")}>
          {props.title}
        </p>
        {props.children && <div className="text-sm text-pretty text-fg-2">{props.children}</div>}
        {props.actions && <div className="mt-2 flex w-full flex-col items-center gap-1">{props.actions}</div>}
      </div>
      <div aria-hidden className="flex-[58]" />
    </div>
  );
}
