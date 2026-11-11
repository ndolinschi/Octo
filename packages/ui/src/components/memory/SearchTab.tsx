import type { MemoryHit, MemorySearchResult } from "@octo/agent-client";
import { Search } from "lucide-react";
import { useId, useRef, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow, useRowKeys } from "../../lib/hooks";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import {
  EMPTY_SEARCH,
  emptyText,
  hitTarget,
  HIT_KIND_LABEL,
  orderHits,
  searchParams,
  searchProblem,
  SEARCH_KINDS,
  toggleKind,
  type HitTarget,
  type SearchForm,
} from "../../lib/memory/search";
import { formatDay } from "../../lib/memory/tasks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Field";
import { Highlight } from "../primitives/Highlight";
import { ErrorState, Loading } from "./parts";

type Result = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ok"; query: string; result: MemorySearchResult };

/**
 * Search the project's memory: tasks, facts, files and messages, narrowed by kind and by date. The harness answers up to 10
 * hits, current facts before superseded ones; an empty answer is said out loud.
 */
export function SearchTab(props: { projectId: string; onOpen(target: NonNullable<HitTarget>): void; canOpenMessage: boolean }) {
  const { bridge } = useApp();
  const [form, setForm] = useState<SearchForm>(EMPTY_SEARCH);
  const [result, setResult] = useState<Result>({ status: "idle" });
  const [touched, setTouched] = useState(false);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  useRowKeys(list);
  const problem = searchProblem(form);
  const search = bridge.searchMemory;
  const run = () => {
    setTouched(true);
    if (problem || !search) return;
    setResult({ status: "loading" });
    const params = searchParams(form);
    search.call(bridge, props.projectId, params).then(
      (r) => setResult({ status: "ok", query: params.q, result: r }),
      (e: unknown) => setResult({ status: "error", message: errorMessage(e) }),
    );
  };
  const now = useNow(false, CLOCK_MINUTE_MS);
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain px-4 pb-6">
      <form
        role="search"
        aria-label="Search memory"
        className="flex flex-col gap-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="flex gap-2">
          <Input
            type="search"
            aria-label="Search memory"
            placeholder="A word or two from the task, fact, file or message"
            value={form.q}
            onChange={(e) => setForm({ ...form, q: e.target.value })}
            aria-invalid={touched && problem !== null && form.q.trim() === ""}
            aria-describedby={`${id}-p`}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" icon={Search} disabled={result.status === "loading"}>
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="Look in" className="flex h-chip shrink-0 gap-0.5">
            {SEARCH_KINDS.map((k) => {
              const on = form.kinds.includes(k.id);
              return (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setForm({ ...form, kinds: toggleKind(form.kinds, k.id) })}
                  className={cn("rounded-sm px-2 text-sm press-row focus-inset", on ? "bg-active text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2")}
                >
                  {k.label}
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-fg-3">
            <label htmlFor={`${id}-a`}>From</label>
            <Input
              id={`${id}-a`}
              type="date"
              value={form.after}
              onChange={(e) => setForm({ ...form, after: e.target.value })}
              className="h-chip w-36 px-2 text-sm"
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-fg-3">
            <label htmlFor={`${id}-b`}>Before</label>
            <Input
              id={`${id}-b`}
              type="date"
              value={form.before}
              onChange={(e) => setForm({ ...form, before: e.target.value })}
              className="h-chip w-36 px-2 text-sm"
            />
          </div>
        </div>
        <p id={`${id}-p`} className="min-h-4 text-xs text-fg-3" aria-live="polite">
          {touched && problem ? problem : form.kinds.length === 0 ? "Looking in everything." : ""}
        </p>
      </form>
      {result.status === "loading" && <Loading rows={4} />}
      {result.status === "error" && <ErrorState message={result.message} onRetry={run} />}
      {result.status === "ok" &&
        (result.result.hits.length === 0 ? (
          <div role="status" className="py-3 text-sm">
            <p className="text-fg">{emptyText(result.result.message)}</p>
            <p className="mt-0.5 text-fg-2">for “{result.query}”. Try one word, or widen the dates.</p>
          </div>
        ) : (
          <div role="region" aria-label="Results">
            <p role="status" className="py-1 text-xs text-fg-3">
              {result.result.hits.length} {result.result.hits.length === 1 ? "hit" : "hits"}, current first
            </p>
            <ul ref={list} className="flex flex-col gap-1">
              {orderHits(result.result.hits).map((h) => (
                <HitCard key={`${h.kind}:${h.id}`} hit={h} query={result.query} now={now} onOpen={props.onOpen} canOpenMessage={props.canOpenMessage} />
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function HitCard(props: { hit: MemoryHit; query: string; now: number; canOpenMessage: boolean; onOpen(target: NonNullable<HitTarget>): void }) {
  const { hit } = props;
  const target = hitTarget(hit);
  const openable = target !== null && (target.to !== "message" || props.canOpenMessage);
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2 text-xs text-fg-3">
        <span className="shrink-0">{HIT_KIND_LABEL[hit.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-fg-2">{hit.title}</span>
        <time dateTime={hit.date} className="shrink-0">
          {formatDay(hit.date, props.now)}
        </time>
      </span>
      {hit.superseded && <span className="text-xs text-warn">Superseded by a newer fact</span>}
      <span className={cn("text-sm break-words", hit.superseded ? "text-fg-3 line-through" : "text-fg")}>
        <Highlight text={hit.snippet} query={props.query.split(/\s+/)[0] ?? ""} />
      </span>
    </>
  );
  const shape = "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left";
  return (
    <li>
      {openable ? (
        <button type="button" data-row onClick={() => props.onOpen(target)} className={cn(shape, "press-row focus-inset hover:bg-hover")}>
          {body}
        </button>
      ) : (
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}
