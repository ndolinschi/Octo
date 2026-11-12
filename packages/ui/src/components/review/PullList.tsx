import { GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { OpenReviewInput, PullRequestList, PullRequestRow, ReviewSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage, timeAgo } from "../../lib/format";
import { useRowKeys } from "../../lib/hooks";
import type { ReviewApi } from "../../lib/review/api";
import { plural } from "../../lib/review/files";
import { orderRows, parsePullInput, rowStatus, unavailableTitle } from "../../lib/review/pull";
import { Button, IconButton } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Field, Input } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { SkeletonRows } from "../primitives/InfoList";
import { Spinner } from "../primitives/Status";
import { ChecksMark, Counts, Notice } from "./parts";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; list: PullRequestList; open: ReviewSummary[] };

/**
 * Pick (RV2 §1): the pull requests of the project's repository, those asking for your review first, with three other ways
 * in: a pasted address or a number, and a local branch (which needs no code host). One click or Enter opens.
 */
export function PullList(props: { api: ReviewApi; folders: readonly { id: string; label: string; path: string }[]; onOpen(reviewId: string): void }) {
  const { api } = props;
  const [folder, setFolder] = useState(props.folders[0]?.label ?? "");
  const [done, setDone] = useState<{ req: string; load: Load } | null>(null);
  const [key, setKey] = useState(0);
  const req = `${folder}:${key}`;
  const load: Load = done?.req === req ? done.load : { status: "loading" };
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);

  useEffect(() => {
    let alive = true;
    // The open reviews are an extra: when they fail the pull requests still list, so only the main call reports an error.
    const open = api.listOpen().catch((): ReviewSummary[] => []);
    api.listPullRequests(folder || undefined).then(
      async (l) => {
        const o = await open;
        if (alive) setDone({ req, load: { status: "ready", list: l, open: o } });
      },
      (e: unknown) => alive && setDone({ req, load: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [api, folder, req]);

  const run = async (id: string, input: OpenReviewInput) => {
    setOpening(id);
    setError(null);
    try {
      const r = await api.open({ ...(folder ? { folder } : {}), ...input });
      props.onOpen(r.id);
    } catch (e) {
      setError(`Could not open it: ${errorMessage(e)}.`);
      setOpening(null);
    }
  };

  const ready = load.status === "ready" ? load : null;
  const available = ready?.list.available === true;
  const rows = ready ? orderRows(ready.list.prs) : [];
  const requested = rows.filter((r) => r.review_requested);
  const others = rows.filter((r) => !r.review_requested);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-home flex-col gap-5 px-4 py-6 max-sm:py-4">
        <header className="flex min-h-8 items-center gap-3">
          <h1 className="min-w-0 shrink truncate text-title text-fg">Review a pull request</h1>
          {ready?.list.repo && <span className="min-w-0 truncate font-mono text-xs text-fg-3 max-sm:hidden">{ready.list.repo}</span>}
          <span className="ml-auto flex items-center gap-2">
            {props.folders.length > 1 && (
              <select
                aria-label="Repository folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                className="h-8 rounded-md border border-input-border bg-panel px-2 text-sm text-fg focus:border-fg focus:outline-none max-sm:text-input-touch"
              >
                {props.folders.map((f) => (
                  <option key={f.id} value={f.label}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
            <IconButton
              icon={RefreshCw}
              label="Reload the list"
              onClick={() => setKey((k) => k + 1)}
              disabled={load.status === "loading"}
              className="max-md:size-10"
            />
          </span>
        </header>

        {ready && available && <ByAddress busy={opening === "address"} onOpen={(input) => run("address", input)} />}
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}

        {load.status === "loading" && <SkeletonRows count={5} widths={[70, 52, 64, 44, 58]} />}
        {load.status === "error" && (
          <Notice
            tone="err"
            title="The pull requests did not load"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setKey((k) => k + 1)}>
                Try again
              </Button>
            }
          >
            {load.message}. You can still review a local branch below.
          </Notice>
        )}
        {ready && !available && (
          <section aria-label="Pull requests are not available" className="flex flex-col gap-3 rounded-md border border-line bg-raised p-4">
            <h2 className="text-heading text-fg">{unavailableTitle(ready.list.reason)}</h2>
            <p className="text-sm text-fg-2">{ready.list.message ?? "Pull requests cannot be listed for this project."}</p>
            {ready.list.command && <CommandLine command={ready.list.command} />}
            <p className="text-xs text-fg-3">Reviewing a local branch below needs no code host.</p>
          </section>
        )}

        {ready && ready.open.length > 0 && (
          <Section title="Reviews in progress">
            {ready.open.map((r) => (
              <OpenRow key={r.id} r={r} busy={opening === r.id} onOpen={() => props.onOpen(r.id)} />
            ))}
          </Section>
        )}
        <div ref={list} className="flex flex-col gap-5">
          {requested.length > 0 && (
            <Section title="Asking for your review">
              {requested.map((r) => (
                <PullRow key={r.number} r={r} busy={opening === `pr${r.number}`} onOpen={() => void run(`pr${r.number}`, { source: "github", pr: r.number })} />
              ))}
            </Section>
          )}
          {others.length > 0 && (
            <Section title={requested.length > 0 ? "Other open pull requests" : "Open pull requests"}>
              {others.map((r) => (
                <PullRow key={r.number} r={r} busy={opening === `pr${r.number}`} onOpen={() => void run(`pr${r.number}`, { source: "github", pr: r.number })} />
              ))}
            </Section>
          )}
          {ready && available && rows.length === 0 && (
            <Notice title="No open pull requests">
              There is nothing open on {ready.list.repo ?? "this repository"} right now. Paste an address or type a number above to review a closed one.
            </Notice>
          )}
        </div>

        <LocalBranch api={api} folders={props.folders} folder={folder} busy={opening === "local"} onOpen={(input) => run("local", input)} />
      </div>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="px-3 text-xs font-medium text-fg-3">{props.title}</h2>
      <div className="flex flex-col">{props.children}</div>
    </section>
  );
}

const ROW = "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left press-row focus-inset hover:bg-hover disabled:opacity-60";

function PullRow({ r, busy, onOpen }: { r: PullRequestRow; busy: boolean; onOpen(): void }) {
  const status = rowStatus(r);
  const [now] = useState(() => Date.now());
  return (
    <button type="button" data-row className={ROW} disabled={busy} aria-busy={busy} onClick={onOpen}>
      <span className="mt-0.5">{busy ? <Spinner /> : <ChecksMark state={r.checks} />}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-sm text-fg">{r.title}</span>
          {status.map((s) => (
            <span key={s} className={cn("shrink-0 text-xs", s.startsWith("New commits") ? "text-warn" : s === "Review requested" ? "text-link" : "text-fg-3")}>
              {s}
            </span>
          ))}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">
          <span>
            #{r.number} by {r.author}
          </span>
          <span>{plural(r.changed_files, "file")}</span>
          <Counts added={r.additions} removed={r.deletions} />
          <span>{timeAgo(r.updated_at, now)}</span>
        </span>
      </span>
    </button>
  );
}

function OpenRow({ r, busy, onOpen }: { r: ReviewSummary; busy: boolean; onOpen(): void }) {
  const [now] = useState(() => Date.now());
  return (
    <button type="button" className={ROW} disabled={busy} onClick={onOpen}>
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

function ByAddress(props: { busy: boolean; onOpen(input: OpenReviewInput): void }) {
  const [text, setText] = useState("");
  const parsed = parsePullInput(text);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!parsed) return;
    props.onOpen({ source: "github", ...(parsed.kind === "number" ? { pr: parsed.pr } : { url: parsed.url }) });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field label="Open by address or number" htmlFor="review-address" className="min-w-60 flex-1">
        <Input
          id="review-address"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a pull request URL, or type 123"
          spellCheck={false}
          autoComplete="off"
          className="max-sm:h-10 max-sm:text-input-touch"
        />
      </Field>
      <Button type="submit" variant="primary" disabled={!parsed || props.busy} className="max-sm:h-10">
        {props.busy && <Spinner />}
        Open
      </Button>
    </form>
  );
}

function LocalBranch(props: {
  api: ReviewApi;
  folders: readonly { label: string; path: string }[];
  folder: string;
  busy: boolean;
  onOpen(input: OpenReviewInput): void;
}) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("main");
  const [head, setHead] = useState("HEAD");
  const path = props.folders.find((f) => f.label === props.folder)?.path;
  const { api } = props;

  // The current branch is the default head; recent folders carry it. Without it the head stays HEAD, which means the same.
  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    api.recentFolders().then(
      (list) => {
        const b = list.find((f) => f.path === path)?.git?.branch;
        if (alive && b) setHead(b);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, open, path]);

  const ok = base.trim() !== "" && head.trim() !== "";
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (ok) props.onOpen({ source: "local", base: base.trim(), head: head.trim() });
  };
  return (
    <section aria-label="Review a local branch" className="flex flex-col gap-2 border-t border-line pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-fit press items-center gap-2 rounded-sm px-2 text-sm text-fg hover:bg-hover max-md:h-10"
      >
        <Glyph icon={GitBranch} size={14} />
        Review a local branch
      </button>
      {open && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-2">
          <Field label="Base" htmlFor="review-base" className="min-w-36 flex-1">
            <Input
              id="review-base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              spellCheck={false}
              className="font-mono max-sm:h-10 max-sm:text-input-touch"
            />
          </Field>
          <Field label="Head" htmlFor="review-head" hint="The current branch by default" className="min-w-36 flex-1">
            <Input
              id="review-head"
              value={head}
              onChange={(e) => setHead(e.target.value)}
              spellCheck={false}
              className="font-mono max-sm:h-10 max-sm:text-input-touch"
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!ok || props.busy} className="mb-5 max-sm:h-10">
            {props.busy && <Spinner />}
            Review
          </Button>
        </form>
      )}
    </section>
  );
}
