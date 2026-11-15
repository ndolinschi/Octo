import { GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenReviewInput, ReviewBranch, ReviewBranchList } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage, timeAgo } from "../../lib/format";
import { useRowKeys } from "../../lib/hooksMore";
import { useRovingRows } from "../../lib/rovingRows";
import { aheadBehindCompact, aheadBehindText, splitName, branchOrder, hasChanges, openInput } from "../../lib/review/branches";
import type { ReviewApi } from "../../lib/review/api";
import { Glyph } from "../primitives/Glyph";
import { SkeletonList } from "../primitives/Skeleton";
import { Spinner } from "../primitives/Status";
import { TextMenu } from "./parts";
import { PanelBody, PanelEmpty } from "../primitives/Panel";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ReviewBranchList };

/**
 * The "Local branches" view of the picker (decision 84): the folder's branches against one base, the current one first. A row
 * opens that branch's review. The base is one quiet menu in the list header; there is no text to type. A harness that cannot
 * list branches gets the current branch only, through the review call it already has.
 */
export function BranchList(props: { api: ReviewApi; folder: string; opening: string | null; onOpen(id: string, input: OpenReviewInput): void }) {
  const { api, folder } = props;
  const [base, setBase] = useState<string | undefined>(undefined);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [now] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  useRovingRows(list);

  useEffect(() => {
    let alive = true;
    const fail = (e: unknown) => alive && setLoad({ status: "error", message: errorMessage(e) });
    if (api.branches) {
      api.branches({ ...(folder ? { folder } : {}), ...(base ? { base } : {}) }).then((data) => alive && setLoad({ status: "ready", data }), fail);
    } else {
      // No branch listing here: the current branch against main, as the review call has always taken it.
      api.recentFolders().then((folders) => {
        const name = folders[0]?.git?.branch ?? "HEAD";
        const at = new Date().toISOString();
        if (!alive) return;
        setLoad({
          status: "ready",
          data: {
            folder,
            base: "main",
            default_base: "main",
            branches: [{ name, current: true, ahead: 1, behind: 0, commit: { sha: "", subject: "", date: at } }],
          },
        });
      }, fail);
    }
    return () => {
      alive = false;
    };
  }, [api, folder, base]);

  const data = load.status === "ready" ? load.data : null;
  const rows = useMemo(() => (data ? branchOrder(data.branches) : []), [data]);
  if (load.status === "loading")
    return (
      <PanelBody>
        <SkeletonList count={5} size="md" twoLine shimmer widths={[60, 48, 54, 44, 50]} />
      </PanelBody>
    );
  if (load.status === "error")
    return <PanelEmpty title="The branches did not load">{load.message}. Check that the folder is a git repository, then pick this view again.</PanelEmpty>;
  const shownBase = data?.base ?? "main";
  // The base is never offered against itself: the current branch is not a base for its own review.
  const current = rows.find((r) => r.current)?.name;
  const names = [...new Set([data?.default_base ?? "main", ...rows.map((r) => r.name)])].filter((n) => n !== current || n === shownBase);
  // R1 (polish step 6b): the list header is the panel's filter row (caption at the rows' text edge, the base menu at the right),
  // the rows sit in the frame's list inset.
  return (
    <section aria-label="Local branches" className="flex h-full min-h-0 flex-col">
      <div data-panel-filters className="box-content flex min-h-9 shrink-0 items-center gap-2 px-pane py-1 touch:min-h-ctl-lg">
        <span className="shrink-0 px-2 text-xs font-medium text-fg-3">{rows.length === 1 && !api.branches ? "Current branch" : "Branches"}</span>
        {api.branches && (
          <span className="ml-auto flex max-w-[65%] min-w-0 items-center">
            <TextMenu
              label="Compare against"
              text={`against ${shownBase}`}
              alignEnd
              items={names.map((n) => ({ id: `base:${n}`, label: n, checked: n === shownBase, run: () => setBase(n) }))}
            />
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <PanelEmpty title="No local branches">This folder has no branch to review. Create one, or switch to Pull requests.</PanelEmpty>
      ) : (
        <PanelBody>
          <div ref={list} className="flex flex-col">
            {rows.map((b) => (
              <BranchRow
                key={b.name}
                b={b}
                now={now}
                busy={props.opening === `branch:${b.name}`}
                onOpen={() => props.onOpen(`branch:${b.name}`, openInput(b, shownBase))}
              />
            ))}
          </div>
          {data?.truncated && (
            <p className="px-2 pt-2 text-xs text-fg-3">More branches exist than are listed. Check one out or delete old ones to see the rest.</p>
          )}
        </PanelBody>
      )}
    </section>
  );
}

/** The list family's anatomy (`ListRow`): 8px side padding, glyph column 16, gap 8, 40px, the hover and focus of a row. */
const BRANCH_ROW = "flex min-h-ctl-lg w-full items-center gap-2 rounded-sm px-2 text-left text-sm press-row focus-inset hover:bg-hover disabled:opacity-60";

function BranchRow({ b, now, busy, onOpen }: { b: ReviewBranch; now: number; busy: boolean; onOpen(): void }) {
  const dim = !hasChanges(b);
  const { head, tail } = splitName(b.name);
  const time = b.commit.date && b.commit.subject ? timeAgo(b.commit.date, now) : "";
  const tone = dim ? "text-fg-3" : "text-fg";
  // Decision 90: the name has the room first (24 characters, cut in the middle); ahead/behind is two short numbers; the subject
  // joins on the same line only when the column is wide, and goes to a second line below the list floor; the time stays right.
  return (
    // eslint-disable-next-line octo/no-native-controls -- name, ahead/behind and subject re-flow by container query (decision 90), which ListRow's fixed title/meta/description slots cannot do
    <button type="button" data-row className={cn(BRANCH_ROW, dim && "text-fg-3")} disabled={busy} aria-busy={busy} onClick={onOpen}>
      <span className="grid size-4 shrink-0 place-items-center text-fg-3">{busy ? <Spinner /> : <Glyph icon={GitBranch} size={14} />}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-3">
          <span title={b.name} className={cn("flex min-w-0 flex-[2] font-mono text-sm @md:min-w-[24ch]", tone)}>
            <span className="min-w-0 truncate">{head}</span>
            {tail && <span className="shrink-0">{tail}</span>}
          </span>
          {b.current && <span className="shrink-0 text-xs text-fg-3">current</span>}
          <span title={aheadBehindText(b)} className="shrink-0 text-xs whitespace-nowrap text-fg-3">
            {aheadBehindCompact(b)}
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-xs text-fg-3 @2xl:block">{b.commit.subject}</span>
        </span>
        <span className="hidden min-w-0 truncate text-xs text-fg-3 @max-md:block">{b.commit.subject}</span>
      </span>
      {time && <span className="shrink-0 self-start pt-0.5 text-right text-xs whitespace-nowrap text-fg-3 @md:self-center @md:pt-0">{time}</span>}
    </button>
  );
}
