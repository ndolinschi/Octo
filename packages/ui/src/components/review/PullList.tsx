import { GitBranch, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { refusalRepoChoices, repoMenu, type OpenReviewInput, type PullRequestFilter, type PullRequestRow, type ReviewSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage, timeAgo } from "../../lib/format";
import { useRowKeys } from "../../lib/hooksMore";
import { useQuietOpen } from "../../lib/quietFocus";
import { useRovingRows } from "../../lib/rovingRows";
import type { ReviewApi } from "../../lib/review/api";
import { plural } from "../../lib/review/files";
import { CHECKS_LABEL, ghInstallCommand, listFailure, parsePullInput, reviewSourceText, unavailableTitle } from "../../lib/review/pull";
import { closesSearch, filterCounts, freshness, PULL_FILTERS, pullRowLine, visibleRows } from "../../lib/review/pullList";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { CommandLine } from "../primitives/CommandLine";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { Notice as ViewNotice } from "../primitives/Notice";
import { SearchField } from "../primitives/SearchField";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { MiddleText } from "../primitives/MiddleText";
import { Panel, PanelBody, PanelEmpty, PanelFilters } from "../primitives/Panel";
import { FilterTabs } from "../primitives/FilterTabs";
import { ViewTabs } from "../primitives/ViewTabs";
import { Spinner } from "../primitives/Status";
import { ScrollArea } from "../primitives/ScrollArea";
import { BranchList } from "./BranchList";
import { CutText, ChecksMark, Counts, TextMenu } from "./parts";
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
export function PullList(props: { api: ReviewApi; folders: Folders; onOpen(reviewId: string): void; returnTo?: string | null }) {
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

/** Whether the folder's list last had the repository menu: the skeleton keeps room for it, so the tabs below never move. */
const seenMenu = new Map<string, boolean>();

/** A refusal that names the folder's repositories: the message and one button per repository (rule 7 of the forks decision). */
type Refusal = { text: string; code: string; choices: { key: string; label: string; detail: string }[]; id: string; input: OpenReviewInput; view: View };

/** Error texts from the harness start lower-case ("the number is in several repositories"): a sentence starts with a capital. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function Picker(props: {
  api: ReviewApi;
  folders: Folders;
  folder: string;
  repo: string | undefined;
  onFolder(label: string): void;
  onRepo(repo: string): void;
  onOpen(reviewId: string): void;
  returnTo?: string | null | undefined;
}) {
  const { api, folder } = props;
  const { state, updating, reload, loadMore, loadingMore, loadMoreError } = usePullList(api, folder, props.repo);
  const [filter, setFilter] = useState<PullRequestFilter>("all");
  const [query, setQuery] = useState("");
  // Under 420px the search is a button that opens the field in place of the chips (work-surface polish item 3).
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchShown = searchOpen || query !== "";
  const [view, setViewState] = useState<View>("pulls");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [now] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  // B2: the search field the dock focuses when the list opens draws no ring until the first key or press.
  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  useRowKeys(list);
  useRovingRows(list);

  const ready = state.list;
  // A refusal or an open error belongs to the view it happened in (decision 91i): changing the view clears it.
  const setView = (next: View) => {
    setViewState(next);
    setError(null);
    setRefusal(null);
  };
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
      if (choices.length > 0) setRefusal({ text, code: (e as { code: string }).code, choices, id, input, view });
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
  if (menu) seenMenu.set(folder, menu.show);

  const available = ready?.available === true;
  const rows = useMemo(() => (ready?.available ? ready.prs : []), [ready]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const shown = useMemo(() => visibleRows(rows, filter, query), [rows, filter, query]);
  const typed = parsePullInput(query);
  const inRows = new Set(rows.map((r) => r.review?.id).filter((x): x is string => x !== undefined));
  const resume = state.open.filter((r) => !inRows.has(r.id));

  // Back from a review (B1 family): focus goes to that pull request's row, else the first row, never to the page.
  const back = useRef(props.returnTo ?? null);
  const listed = !state.loading;
  useEffect(() => {
    const id = back.current;
    if (!id || !listed) return;
    back.current = null;
    const rows = list.current;
    const row = rows?.querySelector<HTMLElement>(`[id="${CSS.escape(`review-row-${id}`)}"]`) ?? rows?.querySelector<HTMLElement>("[data-row]");
    row?.focus({ preventScroll: false });
  }, [listed, rows]);

  const submitSearch = () => {
    if (opening !== null) return;
    if (typed)
      void run("address", {
        source: "github",
        ...(typed.kind === "number" ? { pr: typed.pr, ...(props.repo ? { repo: props.repo } : {}) } : { url: typed.url }),
      });
    else if (shown[0]) openRow(shown[0]);
  };

  // 2026-11-19 (owner: "uneven"): one anatomy in every state. The bar holds what is reviewed, at its 8px inset as Files' crumb:
  // the folder (a menu when the project has several; its name keeps the part that tells it from the others), then the
  // repository; status and refresh at the right. The view row holds only the views. With no repository known (loading, an
  // error) the folder stays, so the bar is never empty and nothing changes rows between states.
  const labels = props.folders.map((f) => f.label);
  const folderLead =
    props.folders.length > 1 ? (
      <TextMenu
        label="Repository folder"
        text={folder}
        siblings={labels}
        items={props.folders.map((f) => ({ id: f.id, label: f.label, title: f.path, checked: f.label === folder, run: () => props.onFolder(f.label) }))}
      />
    ) : null;
  const repoLead = menu?.show ? (
    <TextMenu
      label="Repository"
      text={menu.current}
      // The folder, listed first, gives way before the repository does: its distinct tail stays whole while the owner shrinks.
      className="shrink-[0.7]!"
      items={menu.items.map((i) => ({
        id: i.key,
        label: i.label,
        ...(i.detail ? { detail: i.detail } : {}),
        checked: i.selected,
        run: () => props.onRepo(i.key),
      }))}
    />
  ) : ready ? (
    ready.repo && (
      <span title={ready.repo} className="flex min-w-0 px-2 text-xs text-fg-3">
        <CutText text={ready.repo} />
      </span>
    )
  ) : state.loading && seenMenu.get(folder) !== false ? (
    <span aria-hidden className="grid h-ctl-sm w-40 min-w-0 shrink items-center px-2">
      <span className="h-2 rounded-full bg-hover" />
    </span>
  ) : null;
  const onlyFolder = props.folders[0];
  const lead = (
    <>
      {folderLead}
      {repoLead ||
        (!folderLead && onlyFolder && (
          <span title={onlyFolder.path} className="flex min-w-0 px-2 text-xs text-fg-3">
            <MiddleText text={onlyFolder.label} />
          </span>
        ))}
    </>
  );
  const fresh = updating ? "Updating" : ready ? freshness(ready, now) : "";
  const emptyText =
    rows.length === 0
      ? `Nothing is open on ${ready?.repo ?? "this repository"} right now.`
      : query.trim()
        ? "Nothing matches. Try fewer words, or pick All."
        : "No pull request is in this tab. Pick All to see every open one.";

  return (
    // R1 (polish step 6b): the picker is a `Panel` (header 40, title at 16, view tabs with the frame's hairline, one filter row,
    // the list inset 8). The container query folds the freshness words into the refresh button's tooltip in a narrow group.
    <div ref={quiet} className="@container h-full min-h-0">
      <Panel
        name="review"
        // The tab's name: "Pull requests" is the first view under it, so the title does not say it twice.
        title="Review"
        lead={lead}
        actions={
          <>
            <span role="status" className="flex items-center gap-1.5 px-1 text-xs whitespace-nowrap text-fg-3 empty:hidden @max-[600px]:px-0">
              {updating && <Spinner />}
              {fresh && <span className="@max-[600px]:sr-only">{fresh}</span>}
            </span>
            <IconButton
              icon={RefreshCw}
              label={fresh ? `Check GitHub now (${fresh.toLowerCase()})` : "Check GitHub now"}
              onClick={reload}
              disabled={updating}
            />
          </>
        }
        views={<ViewTabs<View> label="What to review" options={VIEWS} value={view} onChange={setView} />}
      >
        <div className="flex h-full min-h-0 flex-col">
          {view === "pulls" && (available || state.loading) && (
            // R1: the frame's one filter row (36, the chips then the search), as in every other tab. In a narrow group the chips
            // scroll sideways under their fade (FilterTabs) and the search keeps a usable width, so the row never wraps.
            <PanelFilters>
              <FilterTabs<PullRequestFilter>
                label="Show"
                value={filter}
                onChange={setFilter}
                bare
                className={cn(searchShown && "@max-[420px]:hidden")}
                options={PULL_FILTERS.map((f) => ({
                  id: f.id,
                  // Until the list is in, the count is a figure-space placeholder of its width: the chips do not grow on arrival.
                  label: ready ? f.label : `${f.label}${"\u2007".repeat(f.id === "all" ? 2 : 1)}\u2008\u200a`,
                  ...(ready ? { count: counts[f.id] } : {}),
                }))}
              />
              <IconButton
                ref={searchButton}
                icon={Search}
                label="Search pull requests"
                onClick={() => {
                  flushSync(() => setSearchOpen(true));
                  searchInput.current?.focus();
                }}
                className={cn("ml-auto shrink-0 @min-[420px]:hidden", searchShown && "hidden")}
              />
              <SearchField
                ref={searchInput}
                label="Search pull requests, or paste an address or a number"
                placeholder="Search…"
                value={query}
                onChange={setQuery}
                size="sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                  if (closesSearch(e.key, query, searchOpen)) {
                    e.preventDefault();
                    flushSync(() => setSearchOpen(false));
                    searchButton.current?.focus();
                  }
                }}
                inputProps={{ spellCheck: false, autoComplete: "off", onBlur: () => query === "" && setSearchOpen(false) }}
                className={cn("ml-auto max-w-56 min-w-28 flex-1", searchShown ? "@max-[420px]:max-w-none" : "@max-[420px]:hidden")}
              />
            </PanelFilters>
          )}
          {(error || refusal?.view === view) && (
            <div className="flex shrink-0 flex-col gap-2 px-pane pt-1 pb-2">
              {error && <ViewNotice tone="error">{error}</ViewNotice>}
              {refusal?.view === view && (
                <ViewNotice
                  form="block"
                  tone="warn"
                  title={`${sentence(refusal.text)}.`}
                  actions={refusal.choices.map((c) => (
                    <Button key={c.key} size="sm" variant="secondary" onClick={() => choose(c.key)}>
                      <span className="font-mono">{c.label}</span>
                      <span className="text-fg-3">{c.detail}</span>
                    </Button>
                  ))}
                >
                  {refusal.code === "ambiguous_pr" ? "Which repository is it in?" : "Pick the repository to list or open it from."}
                </ViewNotice>
              )}
            </div>
          )}
          {view === "branches" ? (
            <BranchList api={api} folder={folder} opening={opening} onOpen={(id, input) => void run(id, input)} />
          ) : state.loading ? (
            <PanelBody>
              <SkeletonList count={7} size="md" twoLine shimmer widths={[70, 52, 64, 44, 58, 66, 48]} />
            </PanelBody>
          ) : ready && !available && resume.length === 0 ? (
            <PanelEmpty
              title={unavailableTitle(ready.reason)}
              actions={
                <Button size="sm" variant="secondary" onClick={reload}>
                  Reload
                </Button>
              }
            >
              <p>{ready.message ?? "Pull requests cannot be listed for this project."}</p>
              {ready.command && (
                <div className="mt-3 flex flex-col gap-1.5 text-left">
                  <p className="text-xs text-fg-3">Run this in a terminal, then come back and reload:</p>
                  <CommandLine command={ghInstallCommand(ready.command, navigator.platform).command} />
                  <OtherSystems command={ready.command} />
                </div>
              )}
            </PanelEmpty>
          ) : state.error && !ready ? (
            // The tab's empty state, as "not available" above and every tool tab's load failure (centred, one text edge, at every
            // width), not a tinted card from the pane's edge under the views. Reviews in progress stay reachable under it.
            <div className="flex h-full min-h-0 flex-col">
              <ListFailed error={state.error} retrying={updating} onRetry={reload} />
              {resume.length > 0 && (
                <ScrollArea className="max-h-[40%] shrink-0 px-pane pb-2">
                  <section aria-label="Reviews in progress" className="flex flex-col gap-1.5">
                    <SectionHeader inset>Reviews in progress</SectionHeader>
                    {resume.map((r) => (
                      <OpenRow key={r.id} r={r} now={now} onOpen={() => props.onOpen(r.id)} />
                    ))}
                  </section>
                </ScrollArea>
              )}
            </div>
          ) : available && rows.length === 0 && !typed && resume.length === 0 ? (
            <PanelEmpty title="No open pull requests">
              There is nothing open on {ready.repo ?? "this repository"} right now. Paste an address or type a number above to review a closed one.
            </PanelEmpty>
          ) : (
            <PanelBody>
              <div>
                {ready && !available && (
                  <ViewNotice
                    form="block"
                    className="mb-3"
                    title={unavailableTitle(ready.reason)}
                    actions={
                      <Button size="sm" variant="secondary" onClick={reload}>
                        Reload
                      </Button>
                    }
                  >
                    <p>{ready.message ?? "Pull requests cannot be listed for this project."}</p>
                    {ready.command && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <p className="text-xs text-fg-3">Run this in a terminal, then come back and reload:</p>
                        <CommandLine command={ghInstallCommand(ready.command, navigator.platform).command} />
                        <OtherSystems command={ready.command} />
                      </div>
                    )}
                  </ViewNotice>
                )}
                {/* B2: with reviews in progress listed, "nothing open" says so above them (it is about the pull requests). */}
                {available && shown.length === 0 && !typed && resume.length > 0 && <p className="px-2 pb-2 text-sm text-fg-3">{emptyText}</p>}
                {/* R7: the rows are one Tab stop; ↑/↓/Home/End move between them. */}
                {/* A maximised review is 1400 wide: the rows keep Home's column (880, left-aligned as every panel body), so the time
                    and the counts stay near the title they belong to. */}
                <div ref={list} className="flex flex-col gap-1.5">
                  {typed && available && (
                    <ListRow
                      size="md"
                      disabled={opening === "address"}
                      leading={opening === "address" ? <Spinner /> : <Glyph icon={GitBranch} size={14} />}
                      title={typed.kind === "number" ? `Open pull request #${typed.pr}` : "Open this address"}
                      tip={`${typed.kind === "number" ? `Open pull request #${typed.pr}` : "Open this address"} (Enter)`}
                      onClick={submitSearch}
                    />
                  )}
                  {resume.length > 0 && (
                    <section aria-label="Reviews in progress" className="flex flex-col gap-1.5 pb-2">
                      <SectionHeader inset>Reviews in progress</SectionHeader>
                      {resume.map((r) => (
                        <OpenRow key={r.id} r={r} now={now} onOpen={() => props.onOpen(r.id)} />
                      ))}
                    </section>
                  )}
                  {available &&
                    shown.map((r) => (
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
                {available && shown.length === 0 && !typed && resume.length === 0 && <PanelEmpty>{emptyText}</PanelEmpty>}
                {available && ready?.next_page != null && (
                  <div className="flex items-center gap-2 px-2 pt-3">
                    <Button size="sm" variant="secondary" loading={loadingMore} onClick={loadMore}>
                      Load more pull requests
                    </Button>
                    {loadMoreError && <span className="text-xs text-err">{loadMoreError}</span>}
                  </div>
                )}
                {ready?.truncated && ready?.next_page == null && (
                  <p className="px-2 pt-2 text-xs text-fg-3">This repository has more open pull requests than are listed. Search by number to find the rest.</p>
                )}
              </div>
            </PanelBody>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** R2 (polish step 6b): title, then one meta line led by the state word when it matters; time and line counts right-aligned. */
function PullRow({ r, now, busy, showRepo, onOpen }: { r: PullRequestRow; now: number; busy: boolean; showRepo: boolean; onOpen(): void }) {
  const { state, parts } = pullRowLine(r, { showRepo });
  const tone = state ? (state.tone === "warn" ? "text-warn" : state.tone === "strong" ? "text-fg-2" : "text-fg-3") : "";
  return (
    <ListRow
      size="md"
      {...(r.review ? { id: `review-row-${r.review.id}` } : {})}
      disabled={busy}
      tip={r.reviewed_by_me && !state ? `${r.title} (reviewed by you)` : r.title}
      leading={busy ? <Spinner /> : <ChecksMark state={r.checks} />}
      title={
        <>
          {r.title}
          <span className="sr-only">, {CHECKS_LABEL[r.checks]}</span>
        </>
      }
      meta={timeAgo(r.updated_at, now)}
      description={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">
            {state && <span className={cn(tone, state.tone === "strong" && "font-medium")}>{state.text} · </span>}
            {parts.join(" · ")}
          </span>
          <Counts added={r.additions} removed={r.deletions} />
        </span>
      }
      onClick={onOpen}
    />
  );
}

function OpenRow({ r, now, onOpen }: { r: ReviewSummary; now: number; onOpen(): void }) {
  return (
    <ListRow
      size="md"
      id={`review-row-${r.id}`}
      leading={<Glyph icon={GitBranch} size={14} />}
      title={r.title}
      description={
        <>
          <span className="font-mono">{reviewSourceText(r.source)}</span> ·{" "}
          {r.pending_comments > 0 ? plural(r.pending_comments, "pending comment") : "no comments yet"} · {timeAgo(r.last_used_at, now)}
        </>
      }
      onClick={onOpen}
    />
  );
}

/** The list did not load and there is nothing in progress to show: the reason in words, Retry, and the raw text only in Details. */
function ListFailed(props: { error: string; retrying: boolean; onRetry(): void }) {
  const [open, setOpen] = useState(false);
  const { message, hint } = listFailure(props.error);
  return (
    // An alert, as the notice it replaces (`contents`: the block still fills the body's height).
    <div role="alert" className="contents">
      <PanelEmpty
        title="The pull requests did not load"
        actions={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="secondary" loading={props.retrying} disabled={props.retrying} onClick={props.onRetry}>
              Retry
            </Button>
            <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide details" : "Details"}
            </Button>
          </div>
        }
      >
        <p>{message}</p>
        <p>{hint}</p>
        {open && <p className="mt-2 font-mono text-xs break-words whitespace-pre-wrap text-fg-3">{props.error}</p>}
      </PanelEmpty>
    </div>
  );
}

/** B2: the platform's own install command replaces Homebrew's off a Mac; the address covers the rest. */
function OtherSystems({ command }: { command: string }) {
  const other = ghInstallCommand(command, navigator.platform).other;
  return other ? <p className="text-xs text-fg-3">{other}</p> : null;
}
