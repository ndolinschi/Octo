import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Card } from "../primitives/Card";
import { StateGlyph } from "../primitives/StateGlyph";
import { Notice } from "../primitives/Notice";

/**
 * Decision 91c: the one card for "this needs you" (approval, form, plan, always-allow panel, a group of approvals).
 * Header: state glyph · title · dim "what asks" · right-aligned quiet meta (the countdown). Then the body, then ONE action
 * row: `primary` first, quiet `alternatives`, `destructive` last and quiet. It is `primitives/Card` with a focusable,
 * labelled wrapper (the approval's A / D keys live on it). No coloured frame (decision 81).
 */
export type RequestCardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  titleId?: string;
  /** Dim text after the title: who asks, or what it is. */
  asks?: ReactNode;
  /** Right-aligned quiet text: the countdown. */
  meta?: ReactNode;
  glyph?: "needs" | "none";
  children?: ReactNode;
  primary?: ReactNode;
  alternatives?: ReactNode;
  destructive?: ReactNode;
  /** An error under the action row (what happened, what to do). */
  error?: string | null | undefined;
};

export const RequestCard = forwardRef<HTMLElement, RequestCardProps>(function RequestCard(props, ref) {
  const { title, titleId, asks, meta, glyph = "needs", children, primary, alternatives, destructive, error, className, ...rest } = props;
  const hasActions = primary || alternatives || destructive;
  return (
    <Card
      ref={ref}
      as="section"
      className={cn("@container/v7 text-sm focus-visible:not-data-quiet-focus:shadow-[0_0_0_2px_var(--octo-focus)]", className)}
      {...rest}
      header={
        <>
          {/* 7a: the 12px glyph and a 12px gap put the title 24px in, where the activity rows' labels start. */}
          {glyph === "needs" && <StateGlyph state="needs" className="mr-1" />}
          <h3 id={titleId} className="min-w-0 truncate text-heading text-fg">
            {title}
          </h3>
          {asks && <span className="min-w-0 truncate text-fg-3">{asks}</span>}
          {meta && <span className="ml-auto shrink-0 pl-2 text-xs text-fg-3 tabular-nums">{meta}</span>}
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {children}
        {hasActions && (
          <div data-request-actions className="flex flex-wrap items-center gap-2 pt-1">
            {primary}
            {alternatives}
            {destructive}
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
});
