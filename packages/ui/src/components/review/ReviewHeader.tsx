import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { Review } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { reviewTarget } from "../../lib/review/submit";
import { Button, IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";

/**
 * Decision 64: one title row with the single primary action (Submit review), one quiet meta line with at most four facts
 * (what it is, who wrote it, the branches, how far you are), and "Details" for everything else (commits, size, checks,
 * the link: `Overview`). "Update" shows only when the code host has commits this review has not fetched.
 */
export function ReviewHeader(props: {
  review: Review;
  viewed: number;
  pending: number;
  overviewOpen: boolean;
  /** The pull request has commits this review has not fetched yet. */
  behind: boolean;
  refreshing: boolean;
  onOverview(): void;
  onPending(): void;
  onSubmit(): void;
  onRefresh(): void;
  onBack(): void;
}) {
  const r = props.review;
  return (
    <header className="flex shrink-0 flex-col gap-1 border-b border-line pb-2">
      <div className="flex min-h-10 items-center gap-2 px-2 pt-1">
        <IconButton icon={ArrowLeft} label="All pull requests" onClick={props.onBack} className="max-md:size-10" />
        <h1 className="min-w-0 flex-1 truncate text-heading text-fg" title={r.title}>
          {r.title}
          {r.meta.draft && <span className="ml-2 text-xs font-normal text-fg-3">Draft</span>}
        </h1>
        <Button variant="ghost" size="sm" onClick={props.onPending} aria-haspopup="dialog" className="shrink-0 max-md:h-10">
          Pending {props.pending}
        </Button>
        <Button variant="primary" size="sm" onClick={props.onSubmit} className="shrink-0 max-md:h-10">
          Submit review
        </Button>
      </div>
      <div className="flex min-h-6 items-center gap-x-3 px-3 text-xs text-fg-3">
        <span className="shrink-0 font-mono">{reviewTarget(r)}</span>
        {r.author && <span className="shrink-0 max-sm:hidden">{r.author}</span>}
        <span className="min-w-0 truncate font-mono max-md:hidden" title={`${r.head_ref} into ${r.base_ref}`}>
          {r.base_ref} ← {r.head_ref}
        </span>
        <span className="shrink-0 tabular-nums">
          {props.viewed} of {r.totals.files} viewed
        </span>
        {props.behind && r.kind !== "local" && (
          <button
            type="button"
            disabled={props.refreshing}
            onClick={props.onRefresh}
            className="inline-flex h-6 shrink-0 press items-center gap-1 rounded-sm px-2 text-fg-2 hover:bg-hover hover:text-fg max-md:h-10"
          >
            <Glyph icon={RefreshCw} size={14} className={cn(props.refreshing && "animate-spin")} />
            New commits: update
          </button>
        )}
        <button
          type="button"
          aria-expanded={props.overviewOpen}
          onClick={props.onOverview}
          className="ml-auto inline-flex h-6 shrink-0 press items-center gap-1 rounded-sm px-2 text-fg-2 hover:bg-hover hover:text-fg max-md:h-10"
        >
          <Glyph icon={props.overviewOpen ? ChevronDown : ChevronRight} size={14} />
          Details
        </button>
      </div>
    </header>
  );
}
