import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { Review } from "@octo/agent-client";
import { plural } from "../../lib/review/files";
import { reviewTarget } from "../../lib/review/submit";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { IconMenu } from "../primitives/IconMenu";
import type { MenuItem } from "../primitives/Menu";
import { usePhone } from "../../lib/phone";

/**
 * Decision 64 and 78, polish step 6b (R3), tool-tab consistency pass: one 40px bar at every width, like every other tool tab
 * (Back, the title, one right-hand group of 28px controls with "Submit review" last, a `line` hairline under it). What the
 * meta line used to say (what it is, who wrote it, the branches, how far you are, open threads) is the title's tooltip and
 * leads Details (`Overview`); "New commits: update" is a quiet button in the group (in "⋯" when it folds).
 *
 * The group folds by the header's own width (container `rh`), in this declared order, never wrapping:
 *   below 1024  the pinned commands go into "Run ▾" (which already lists them) — in `commands/RunBar`;
 *   below 720   Check out, the update, Pending and Details go into "⋯";
 *   below 480   "Run" becomes its play glyph (RunBar) and "Submit review" says "Submit".
 */
export function ReviewHeader(props: {
  review: Review;
  viewed: number;
  pending: number;
  /** Findings of an agent review wait in the same panel: Pending shows for them too. */
  findings: number;
  unresolved: number;
  overviewOpen: boolean;
  /** The pull request has commits this review has not fetched yet. */
  behind: boolean;
  refreshing: boolean;
  runs: ReactNode;
  checkout: ReactNode;
  checkoutItems: MenuItem[];
  onOverview(): void;
  onPending(): void;
  onSubmit(): void;
  onRefresh(): void;
  onBack(): void;
}) {
  const r = props.review;
  // A1.3: a phone's header has the one Back (the open review is a history layer, `ReviewTab`); the review drops its own.
  const phone = usePhone();
  const update = props.behind && r.kind !== "local";
  const facts = [
    reviewTarget(r),
    r.author ?? "",
    `${r.base_ref} ← ${r.head_ref}`,
    `${props.viewed} of ${r.totals.files} viewed`,
    props.unresolved > 0 ? plural(props.unresolved, "unresolved thread") : "",
  ].filter(Boolean);
  const more: MenuItem[] = [
    ...(props.pending > 0 || props.findings > 0
      ? [{ id: "pending", label: props.pending > 0 ? `Pending comments (${props.pending})` : `Findings (${props.findings})`, run: props.onPending }]
      : []),
    { id: "details", label: props.overviewOpen ? "Hide details" : "Show details", run: props.onOverview },
    ...(update ? [{ id: "update", label: "New commits: update", run: props.onRefresh }] : []),
    ...(props.checkoutItems.length > 0 ? [{ id: "sep-checkout", separator: true } as const, ...props.checkoutItems] : []),
  ];
  const submit = `Submit review${props.pending > 0 ? ` · ${props.pending}` : ""}`;
  return (
    // A div, not <header>: the window has its own banner (axe landmark-no-duplicate-banner).
    <div data-review-header className="@container/rh flex h-ctl-lg shrink-0 items-center gap-2 px-pane shadow-[inset_0_-1px_0_var(--octo-line)]">
      {!phone && <IconButton icon={ArrowLeft} label="All pull requests" onClick={props.onBack} />}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 px-1" title={`${r.title}\n${facts.join(" · ")}`}>
        <h1 className="min-w-0 truncate text-heading text-fg">{r.title}</h1>
        {r.meta.draft && <span className="shrink-0 text-xs text-fg-3">Draft</span>}
      </div>
      <div data-review-actions className="flex shrink-0 items-center gap-1">
        {props.runs}
        <span className="flex items-center gap-1 @max-[720px]/rh:hidden">
          {props.checkout}
          {update && (
            <Button variant="quiet" size="sm" icon={RefreshCw} loading={props.refreshing} onClick={props.onRefresh}>
              New commits: update
            </Button>
          )}
          {/* B2: nothing pending, no button (the submit sheet takes a general comment); it appears with the first comment. */}
          {(props.pending > 0 || props.findings > 0) && (
            <Button variant="quiet" size="sm" onClick={props.onPending} aria-haspopup="dialog" className="tabular-nums">
              {props.pending > 0 ? `Pending ${props.pending}` : `Findings ${props.findings}`}
            </Button>
          )}
          <Button
            variant="quiet"
            size="sm"
            icon={props.overviewOpen ? ChevronDown : ChevronRight}
            aria-expanded={props.overviewOpen}
            onClick={props.onOverview}
          >
            Details
          </Button>
        </span>
        <span className="flex @min-[720px]/rh:hidden">
          <IconMenu label="More review actions" items={more} />
        </span>
        {/* Secondary, not filled: no tool tab has a filled button in its bar. */}
        <Button variant="secondary" size="sm" onClick={props.onSubmit} aria-label={submit} className="ml-1">
          <span className="@max-[480px]/rh:hidden">{submit}</span>
          <span aria-hidden className="@min-[480px]/rh:hidden">
            Submit{props.pending > 0 ? ` · ${props.pending}` : ""}
          </span>
        </Button>
      </div>
    </div>
  );
}
