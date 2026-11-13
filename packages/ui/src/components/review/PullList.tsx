import { GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { refusalRepoChoices, repoMenu, type OpenReviewInput, type PullRequestFilter, type PullRequestRow, type ReviewSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage, timeAgo } from "../../lib/format";
import { useRowKeys } from "../../lib/hooks";
import type { ReviewApi } from "../../lib/review/api";
import { plural } from "../../lib/review/files";
import { CHECKS_LABEL, listFailure, parsePullInput, reviewSourceText, unavailableTitle } from "../../lib/review/pull";
import { filterCounts, freshness, PULL_FILTERS, pullRowLine, visibleRows } from "../../lib/review/pullList";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { CommandLine } from "../primitives/CommandLine";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { Notice as ViewNotice } from "../primitives/Notice";
import { SearchField } from "../primitives/SearchField";
import { SkeletonRows } from "../primitives/InfoList";
import { MiddleText } from "../primitives/MiddleText";
import { Panel, PanelBody, PanelEmpty } from "../primitives/Panel";
import { FilterTabs } from "../primitives/FilterTabs";
import { ViewTabs } from "../primitives/ViewTabs";
import { Spinner } from "../primitives/Status";
import { ErrorNotice } from "../shared/ErrorNotice";
import { BranchList } from "./BranchList";
import { ChecksMark, Counts, TextMenu } from "./parts";
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
  const { state, updating, reload } = usePullList(api, folder, props.repo);
  const [filter, setFilter] = useState<PullRequestFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<View>("pulls");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [now] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list, { roving: true });

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
    if (typed) void run("address", { source: "github", ...(typed.kind === "number" ? { pr: typed.pr } : { url: typed.url }) });
    else if (shown[0]) openRow(shown[0]);
  };

  const lead = menu?.show ? (
    <TextMenu
      label="Repository"
      text={menu.current}
      mono
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
        <MiddleText text={ready.repo} className="font-mono" />
      </span>
    )
  ) : state.loading && seenMenu.get(folder) !== false ? (
    <span aria-hidden className="grid h-ctl-sm w-40 min-w-0 shrink items-center px-2">
      <span className="h-2 rounded-full bg-hover" />
    </span>
  ) : null;
  const fresh = updating ? "Updating" : ready ? freshness(ready, now) : "";

  return (
    // R1 (polish step 6b): the picker is a `Panel` (header 40, title at 16, view tabs with the frame's hairline, one filter row,
    // the list inset 8). The container query folds the freshness words into the refresh button's tooltip in a narrow group.
    <div className="@container h-full min-h-0">
      <Panel
        name="review"
        title="Pull requests"
        lead={lead || undefined}
        actions={
          <>
            <span role="status" className="flex items-center gap-1.5 px-1 text-xs whitespace-nowrap text-fg-3 empty:hidden">
              {updating && <Spinner />}
              {fresh && <span className="@max-[600px]:sr-only">{fresh}</span>}
            </span>
            <IconButton
              icon={RefreshCw}
              label={fresh ? `Ask the code host now (${fresh.toLowerCase()})` : "Ask the code host now"}
              onClick={reload}
              disabled={updating}
            />
          </>
        }
        views={
          <ViewTabs<View>
            label="What to review"
            options={VIEWS}
            value={view}
            onChange={setView}
            // The folder scopes both views: it sits at the view row's end, so the header keeps the repository whole in a
            // narrow group (R1 asks for it in the header line; there it cut the repository to "/atlas-api" at 360px).
            trailing={
              props.folders.length > 1 ? (
                <TextMenu
                  label="Repository folder"
                  text={folder}
                  alignEnd
                  items={props.folders.map((f) => ({ id: f.id, label: f.label, checked: f.label === folder, run: () => props.onFolder(f.label) }))}
                />
              ) : undefined
            }
          />
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          {view === "pulls" && (available || state.loading) && (
            // R1: the frame's one filter row (36, the chips then the search). In a narrow group (under 560) the search takes a
            // line of its own above the chips, so neither is cut to a stub.
            <div
              data-panel-filters
              className="box-content flex min-h-9 max-w-home shrink-0 items-center gap-x-2 gap-y-1 px-pane @max-[560px]:flex-wrap @max-[560px]:pt-1 touch:min-h-ctl-lg"
            >
              <FilterTabs<PullRequestFilter>
                label="Show"
                value={filter}
                onChange={setFilter}
                bare
                options={PULL_FILTERS.map((f) => ({
                  id: f.id,
                  // Until the list is in, the count is a figure-space placeholder of its width: the chips do not grow on arrival.
                  label: ready ? f.label : `${f.label}${"\u2007".repeat(f.id === "all" ? 2 : 1)}\u2008\u200a`,
                  ...(ready ? { count: counts[f.id] } : {}),
                }))}
              />
              <SearchField
                label="Search pull requests, or paste an address or a number"
                placeholder="Search or paste a PR link"
                value={query}
                onChange={setQuery}
                size="sm"
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                inputProps={{ spellCheck: false, autoComplete: "off" }}
                className="ml-auto w-56 shrink-0 @max-[560px]:order-first @max-[560px]:w-full"
              />
            </div>
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
              <SkeletonRows count={7} widths={[70, 52, 64, 44, 58, 66, 48]} />
            </PanelBody>
          ) : ready && !available && resume.length === 0 ? (
            <PanelEmpty
              title={unavailableTitle(ready.reason)}
              actions={
                <Button size="sm" variant="secondary" onClick={reload}>
                  I ran it: reload
                </Button>
              }
            >
              <p>{ready.message ?? "Pull requests cannot be listed for this project."}</p>
              {ready.command && (
                <div className="mt-3 flex flex-col gap-1.5 text-left">
                  <p className="text-xs text-fg-3">Run this in a terminal, then come back and reload:</p>
                  <CommandLine command={ready.command} />
                </div>
              )}
            </PanelEmpty>
          ) : state.error && !ready && resume.length === 0 ? (
            <PanelBody>
              <ErrorNotice
                title="The pull requests did not load"
                fields={{ ...listFailure(state.error), details: state.error, action: "retry" }}
                onRetry={reload}
                retrying={updating}
              />
            </PanelBody>
          ) : available && rows.length === 0 && !typed && resume.length === 0 ? (
            <PanelEmpty title="No open pull requests">
              There is nothing open on {ready.repo ?? "this repository"} right now. Paste an address or type a number above to review a closed one.
            </PanelEmpty>
          ) : (
            <PanelBody>
              {/* The list is not available, but reviews in progress are: say why above them (a tone, no outline). */}
              {state.error && !ready && (
                <div className="max-w-home pb-3">
                  <ErrorNotice
                    title="The pull requests did not load"
                    fields={{ ...listFailure(state.error), details: state.error, action: "retry" }}
                    onRetry={reload}
                    retrying={updating}
                  />
                </div>
              )}
              {ready && !available && (
                <section aria-label="Pull requests are not available" className="octo-in-card mb-3 flex max-w-home flex-col gap-2 rounded-md bg-raised p-4">
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
              {/* R7: the rows are one Tab stop; ↑/↓/Home/End move between them. */}
              {/* A maximised review is 1400 wide: the rows keep Home's column (880, left-aligned as every panel body), so the time
                  and the counts stay near the title they belong to. */}
              <div ref={list} className="flex max-w-home flex-col">
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
                  <section aria-label="Reviews in progress" className="flex flex-col pb-2">
                    <h2 className="flex h-ctl-md items-center px-2 text-xs font-medium text-fg-3">Reviews in progress</h2>
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
              {available && shown.length === 0 && !typed && (
                <PanelEmpty>
                  {rows.length === 0
                    ? `Nothing is open on ${ready.repo ?? "this repository"} right now.`
                    : query.trim()
                      ? "Nothing matches. Try fewer words, or pick All."
                      : "No pull request is in this tab. Pick All to see every open one."}
                </PanelEmpty>
              )}
              {ready?.truncated && (
                <p className="px-2 pt-2 text-xs text-fg-3">This repository has more open pull requests than are listed. Search by number to find the rest.</p>
              )}
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
