import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import type { Review } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { plural, totalsText } from "../../lib/review/files";
import { reviewTarget } from "../../lib/review/submit";
import { Button, IconButton } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { ChecksMark, checksState } from "./parts";

/**
 * Title, author, branches, checks, commits and progress of a review, with the three things you do from here: look at
 * the pull request's own text (Overview), see what is pending, submit. Everything from the pull request is text.
 */
export function ReviewHeader(props: {
  review: Review;
  viewed: number;
  pending: number;
  findings: number;
  overviewOpen: boolean;
  refreshing: boolean;
  onOverview(): void;
  onPending(): void;
  onSubmit(): void;
  onRefresh(): void;
  onBack(): void;
}) {
  const r = props.review;
  const web = r.url && /^https?:\/\//.test(r.url) ? r.url : null;
  return (
    <header className="flex shrink-0 flex-col border-b border-line">
      <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1">
        <IconButton icon={ArrowLeft} label="All pull requests" onClick={props.onBack} className="max-md:size-10" />
        <h1 className="min-w-36 flex-1 truncate text-heading text-fg" title={r.title}>
          {r.title}
        </h1>
        {r.meta.draft && <span className="shrink-0 rounded-xs border border-line-strong px-1.5 text-xs text-fg-2">Draft</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton
            icon={RefreshCw}
            label={props.refreshing ? "Refreshing" : "Refresh from the code host"}
            disabled={props.refreshing || r.kind === "local"}
            onClick={props.onRefresh}
            className={cn("max-md:size-10", props.refreshing && "animate-spin")}
          />
          <Button variant="secondary" size="sm" onClick={props.onPending} aria-haspopup="dialog" className="max-md:h-10">
            Pending {props.pending}
            {props.findings > 0 && <span className="text-fg-3 max-sm:hidden">· {plural(props.findings, "finding")}</span>}
          </Button>
          <Button variant="primary" size="sm" onClick={props.onSubmit} className="max-md:h-10">
            Submit review
          </Button>
        </span>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-xs text-fg-2">
        <span className="font-mono text-fg-3">{reviewTarget(r)}</span>
        {r.author && <span>{r.author}</span>}
        <span className="min-w-0 truncate font-mono" title={`${r.head_ref} into ${r.base_ref}`}>
          {r.base_ref} <span className="text-fg-3">←</span> {r.head_ref}
        </span>
        {r.kind === "github" && <ChecksMark state={checksState(r.meta.checks_state)} withLabel />}
        <span>{plural(r.meta.commits.length, "commit")}</span>
        <span>{totalsText(r.totals)}</span>
        <span className="tabular-nums">
          {props.viewed} of {r.totals.files} viewed
        </span>
        {r.large_pr && <span className="text-warn">Large pull request: take it group by group</span>}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-link underline-offset-2 hover:underline max-sm:hidden"
          >
            {new URL(web).host}
            <Glyph icon={ExternalLink} size={14} />
          </a>
        )}
        <button
          type="button"
          aria-expanded={props.overviewOpen}
          onClick={props.onOverview}
          className="ml-auto inline-flex h-6 press items-center gap-1 rounded-sm px-2 text-fg-2 hover:bg-hover hover:text-fg max-md:h-10"
        >
          <Glyph icon={props.overviewOpen ? ChevronDown : ChevronRight} size={14} />
          <span className="max-sm:hidden">Description, conversation, checks</span>
          <span className="sm:hidden">Overview</span>
        </button>
      </div>
    </header>
  );
}
