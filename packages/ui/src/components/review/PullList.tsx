import { GitBranch, RefreshCw, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { refusalRepoChoices, repoMenu, type OpenReviewInput, type PullRequestFilter, type PullRequestRow, type ReviewSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage, timeAgo } from "../../lib/format";
import { useRowKeys } from "../../lib/hooks";
import type { ReviewApi } from "../../lib/review/api";
import { plural } from "../../lib/review/files";
import { parsePullInput, unavailableTitle } from "../../lib/review/pull";
import { filterCounts, freshness, newSinceMyReview, PULL_FILTERS, visibleRows } from "../../lib/review/pullList";
import { Button, IconButton } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Input } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { SkeletonRows } from "../primitives/InfoList";
import { MenuButton } from "../primitives/MenuButton";
import { Segmented } from "../primitives/Segmented";
import { ViewTabs } from "../primitives/ViewTabs";
import { Spinner } from "../primitives/Status";
import { BranchList } from "./BranchList";
import { ChecksMark, Counts, Notice, ROW } from "./parts";
import { usePullList } from "./usePullList";

type View = "pulls" | "branches";
const VIEWS: readonly { id: View; label: string }[] = [
  { id: "pulls", label: "Pull requests" },
  { id: "branches", label: "Local branches" },
];

type Folders = readonly { id: string; label: string; path: string }[];

/**
 * Pick (decisions 77 and 78): every open pull request of the project's repository, newest activity first, with the filter
 * tabs and one search field that also takes a pasted address or a number. The last list paints at once; the refresh
 * happens behind it. One click, or Enter on the first result, opens the review.
 */
export function PullList(props: { api: ReviewApi; folders: Folders; onOpen(reviewId: string): void }) {
  const [folder, setFolder] = useState(props.folders[0]?.label ?? "");
  // The repository choice belongs to a folder: undefined is the harness's default for it.
  const [repo, setRepo] = useState<string | undefined>(undefined);
  return (
    <Picker
      key={`${folder}|${repo ?? ""}`}
      {...props}
      folder={folder}
      repo={repo}
      onFolder={(f) => {
        setRepo(undefined);
        setFolder(f);
      }}
      onRepo={setRepo}
    />
  );
}

/** A refusal that names the folder's repositories: the message and one button per repository (rule 7 of the forks decision). */
type Refusal = { text: string; code: string; choices: { key: string; label: string; detail: string }[]; id: string; input: OpenReviewInput };

function Picker(props: {
  api: ReviewApi;
  folders: Folders;
  folder: string;
  repo: string | undefined;
  onFolder(label: string): void;
  onRepo(repo: string): void;
  onOpen(reviewId: string): void;
}) {
  const { api, folder } = props;
  const { state, updating, reload } = usePullList(api, folder, props.repo);
  const [filter, setFilter] = useState<PullRequestFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("pulls");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [now] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);

  const ready = state.list;
  const run = async (id: string, input: OpenReviewInput) => {
    setOpening(id);
    setError(null);
    setRefusal(null);
    try {
      const r = await api.open({ ...(folder ? { folder } : {}), ...input });
      props.onOpen(r.id);
    } catch (e) {
      const choices = refusalRepoChoices(e as { code?: string; repos?: never });
      const text = errorMessage(e).replace(/\.$/, "");
      if (choices.length > 0) setRefusal({ text, code: (e as { code: string }).code, choices, id, input });
      else setError(`Could not open it: ${text}. Check the address, or try again.`);
      setOpening(null);
    }
  };
  const openRow = (r: PullRequestRow) => void run(`pr${r.number}`, { source: "github", pr: r.number, ...(r.repo ? { repo: r.repo } : {}) });
  const choose = (key: string) => {
    if (!refusal) return;
    // ambiguous_pr: the number is in several repositories, open it in the chosen one. Otherwise list that repository.
    if (refusal.code === "ambiguous_pr") void run(refusal.id, { ...refusal.input, repo: key });
    else {
      setRefusal(null);
      props.onRepo(key);
    }
  };
  const menu = ready ? repoMenu(ready) : null;

  const available = ready?.available === true;
  const rows = useMemo(() => (ready?.available ? ready.prs : []), [ready]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const shown = useMemo(() => visibleRows(rows, filter, query), [rows, filter, query]);
  const typed = parsePullInput(query);
  const inRows = new Set(rows.map((r) => r.review?.id).filter((x): x is string => x !== undefined));
  const resume = state.open.filter((r) => !inRows.has(r.id));

  const submitSearch = () => {
    if (typed) void run("address", { source: "github", ...(typed.kind === "number" ? { pr: typed.pr } : { url: typed.url }) });
    else if (shown[0]) openRow(shown[0]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="@container mx-auto flex w-full max-w-home flex-col gap-4 px-4 py-6 max-sm:py-4">
        <header className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="shrink-0 text-title whitespace-nowrap text-fg">Pull requests</h1>
          {menu?.show ? (
            <MenuButton
              label="Repository"
              text={menu.current}
              className="min-w-0 font-mono text-xs"
              items={menu.items.map((i) => ({
                id: i.key,
                label: i.label,
                ...(i.detail ? { detail: i.detail } : {}),
                checked: i.selected,
                run: () => props.onRepo(i.key),
              }))}
            />
          ) : (
            ready?.repo && <span className="min-w-0 truncate font-mono text-xs text-fg-3 @max-md:hidden">{ready.repo}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {props.folders.length > 1 && (
              <MenuButton
                label="Repository folder"
                text={folder}
                alignEnd
                items={props.folders.map((f) => ({ id: f.id, label: f.label, checked: f.label === folder, run: () => props.onFolder(f.label) }))}
              />
            )}
            <span role="status" className="flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-3 @max-md:[&_span:last-child]:hidden">
              {updating ? (
                <>
                  <Spinner /> Updating
                </>
              ) : ready ? (
                freshness(ready, now)
              ) : null}
            </span>
            <IconButton icon={RefreshCw} label="Ask the code host now" onClick={reload} disabled={updating} className="max-md:size-10" />
          </span>
        </header>

        <ViewTabs<View> label="What to review" options={VIEWS} value={view} onChange={setView} className="px-0!" />

        {view === "branches" && <BranchList api={api} folder={folder} opening={opening} onOpen={(id, input) => void run(id, input)} />}

        {view === "pulls" && (available || state.loading) && (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Glyph icon={Search} size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3" />
              <Input
                aria-label="Search pull requests, or paste an address or a number"
                placeholder="Search, or paste a pull request address or number"
                value={query}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                className="pl-9 max-sm:h-10 max-sm:text-input-touch"
              />
            </div>
            <div className="overflow-x-auto">
              <Segmented<PullRequestFilter>
                label="Show"
                value={filter}
                onChange={setFilter}
                options={PULL_FILTERS.map((f) => ({ id: f.id, label: ready ? `${f.label} ${counts[f.id]}` : f.label }))}
              />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
        {refusal && (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3">
            <p className="text-sm text-err">{refusal.text}.</p>
            <p className="text-xs text-fg-3">
              {refusal.code === "ambiguous_pr" ? "Which repository is it in?" : "Pick the repository to list or open it from:"}
            </p>
            <div className="flex flex-wrap gap-2">
              {refusal.choices.map((c) => (
                <Button key={c.key} size="sm" variant="secondary" onClick={() => choose(c.key)}>
                  <span className="font-mono">{c.label}</span>
                  <span className="text-fg-3">{c.detail}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {view === "pulls" && state.loading && <SkeletonRows count={7} widths={[70, 52, 64, 44, 58, 66, 48]} />}
        {view === "pulls" && state.error && !ready && (
          <Notice
            tone="err"
            title="The pull requests did not load"
            actions={
              <Button size="sm" variant="secondary" onClick={reload}>
                Try again
              </Button>
            }
          >
            {state.error}. You can still review a local branch: pick Local branches above.
          </Notice>
        )}
        {view === "pulls" && ready && !available && (
          <section aria-label="Pull requests are not available" className="flex flex-col gap-3 rounded-md border border-line bg-raised p-4">
            <h2 className="text-heading text-fg">{unavailableTitle(ready.reason)}</h2>
            <p className="text-sm text-fg-2">{ready.message ?? "Pull requests cannot be listed for this project."}</p>
            {ready.command && (
              <>
                <p className="text-xs text-fg-3">Run this in a terminal, then come back and reload:</p>
                <CommandLine command={ready.command} />
              </>
            )}
            <div>
              <Button size="sm" variant="secondary" onClick={reload}>
                I ran it: reload
              </Button>
            </div>
          </section>
        )}

        {view === "pulls" && (
          <div ref={list} className="flex flex-col gap-4">
            {typed && available && (
              <button type="button" data-row disabled={opening === "address"} onClick={submitSearch} className={cn(ROW, "items-center")}>
                {opening === "address" ? <Spinner /> : <Glyph icon={GitBranch} size={14} />}
                <span className="text-sm text-fg">{typed.kind === "number" ? `Open pull request #${typed.pr}` : "Open this address"}</span>
                <span className="ml-auto text-xs text-fg-3">Enter</span>
              </button>
            )}
            {resume.length > 0 && (
              <section className="flex flex-col gap-1">
                <h2 className="px-3 text-xs font-medium text-fg-3">Reviews in progress</h2>
                {resume.map((r) => (
                  <OpenRow key={r.id} r={r} now={now} onOpen={() => props.onOpen(r.id)} />
                ))}
              </section>
            )}
            {available && shown.length > 0 && (
              <div className="flex flex-col">
                {shown.map((r) => (
                  <PullRow
                    key={`${r.repo ?? ""}#${r.number}`}
                    r={r}
                    showRepo={menu?.rowsShowRepo === true}
                    now={now}
                    busy={opening === `pr${r.number}`}
                    onOpen={() => openRow(r)}
                  />
                ))}
              </div>
            )}
            {available && shown.length === 0 && !typed && (
              <Notice title={rows.length === 0 ? "No open pull requests" : "Nothing matches"}>
                {rows.length === 0
                  ? `There is nothing open on ${ready.repo ?? "this repository"} right now. Paste an address or type a number above to review a closed one.`
                  : query.trim()
                    ? "Try fewer words, or pick All."
                    : "No pull request is in this tab. Pick All to see every open one."}
              </Notice>
            )}
            {ready?.truncated && (
              <p className="px-3 text-xs text-fg-3">This repository has more open pull requests than are listed. Search by number to find the rest.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The few words that matter on a row, most important first; "new since your review" is the only one that is not dim. */
function badges(r: PullRequestRow): { text: string; tone: "warn" | "link" | "dim" }[] {
  const out: { text: string; tone: "warn" | "link" | "dim" }[] = [];
  if (newSinceMyReview(r)) out.push({ text: "New since your review", tone: "warn" });
  else if (r.review_requested) out.push({ text: "Review requested", tone: "link" });
  else if (r.reviewed_by_me) out.push({ text: "Reviewed by you", tone: "dim" });
  if (r.draft) out.push({ text: "Draft", tone: "dim" });
  if (r.review && r.review.pending_comments > 0) out.push({ text: `${r.review.pending_comments} pending`, tone: "dim" });
  return out;
}

function PullRow({ r, now, busy, showRepo, onOpen }: { r: PullRequestRow; now: number; busy: boolean; showRepo: boolean; onOpen(): void }) {
  return (
    <button type="button" data-row className={ROW} disabled={busy} aria-busy={busy} onClick={onOpen}>
      <span className="mt-0.5">{busy ? <Spinner /> : <ChecksMark state={r.checks} />}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-fg">{r.title}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">
          {badges(r).map((b) => (
            <span key={b.text} className={cn(b.tone === "warn" ? "text-warn" : b.tone === "link" ? "text-link" : "text-fg-3")}>
              {b.text}
            </span>
          ))}
          {showRepo && r.repo && <span className="font-mono">{r.repo}</span>}
          <span>
            #{r.number} by {r.mine ? "you" : r.author}
          </span>
          <span>{plural(r.changed_files, "file")}</span>
          <Counts added={r.additions} removed={r.deletions} />
          {(r.comments ?? 0) > 0 && <span>{plural(r.comments ?? 0, "comment")}</span>}
          <span>{timeAgo(r.updated_at, now)}</span>
        </span>
      </span>
    </button>
  );
}

function OpenRow({ r, now, onOpen }: { r: ReviewSummary; now: number; onOpen(): void }) {
  return (
    <button type="button" className={ROW} onClick={onOpen}>
      <span className="mt-0.5 text-fg-3">
        <Glyph icon={GitBranch} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-fg">{r.title}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-fg-3">
          <span className="font-mono">{r.source}</span>
          <span>{r.pending_comments > 0 ? plural(r.pending_comments, "pending comment") : "no comments yet"}</span>
          <span>{timeAgo(r.last_used_at, now)}</span>
        </span>
      </span>
    </button>
  );
}
