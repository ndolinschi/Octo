import { useState } from "react";
import type { Review, ReviewConversationItem } from "@octo/agent-client";
import { timeAgo } from "../../lib/format";
import { plural, totalsText } from "../../lib/review/files";
import { reviewTarget } from "../../lib/review/submit";
import { TheirText } from "./ExternalText";
import { ViewTabs } from "../primitives/ViewTabs";
import { ChecksMark, checksState } from "./parts";

type Section = "description" | "conversation" | "checks" | "commits";

function Item({ item, now }: { item: ReviewConversationItem; now: number }) {
  return (
    <li className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-fg">{item.author}</span>
        <span className="text-xs text-fg-3">
          {item.kind === "review" ? `reviewed${item.state ? `: ${item.state.toLowerCase().replace(/_/g, " ")}` : ""}` : "commented"}
          {item.created_at ? ` · ${timeAgo(item.created_at, now)}` : ""}
        </span>
      </p>
      {item.body.trim() ? <TheirText who={item.author} text={item.body} /> : <p className="text-xs text-fg-3">No text.</p>}
    </li>
  );
}

/** Above the diff, on demand: the description, the conversation, the checks and the commits of the pull request. */
export function Overview({
  review,
  facts,
}: {
  review: Review;
  /** The header is one bar, so what it is, who wrote it and how far you are lead here. */ facts?: string;
}) {
  const [now] = useState(() => Date.now());
  const conversation = review.meta.conversation ?? [];
  const checks = review.meta.checks ?? [];
  const [section, setSection] = useState<Section>("description");
  const web = review.url && /^https?:\/\//.test(review.url) ? review.url : null;
  return (
    <section aria-label="Pull request overview" className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-panel px-4 py-3">
      {facts !== undefined && (
        <p className="text-xs text-fg-3">
          <span className="font-mono">{reviewTarget(review)}</span>
          {review.author ? ` · ${review.author}` : ""} · <span className="font-mono">{`${review.base_ref} ← ${review.head_ref}`}</span> · {facts}
        </p>
      )}
      {/* The facts the header does not carry (decision 64): size, checks, the link, and a large pull request's warning. */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
        <span>{plural(review.meta.commits.length, "commit")}</span>
        <span>{totalsText(review.totals)}</span>
        {review.kind === "github" && <ChecksMark state={checksState(review.meta.checks_state)} withLabel />}
        {review.large_pr && <span className="text-warn">Large pull request: take it group by group</span>}
        {web && (
          <a href={web} target="_blank" rel="noreferrer noopener" className="text-link underline-offset-2 hover:underline">
            Open on {new URL(web).host}
          </a>
        )}
      </p>
      <ViewTabs<Section>
        label="Overview section"
        value={section}
        onChange={setSection}
        className="-mx-4"
        options={[
          { id: "description", label: "Description" },
          { id: "conversation", label: `Conversation ${conversation.length}` },
          { id: "checks", label: `Checks ${checks.length}` },
          { id: "commits", label: `Commits ${review.meta.commits.length}` },
        ]}
      />
      {section === "description" &&
        (review.body.trim() ? (
          <>
            <TheirText who={review.author ?? "the author"} text={review.body} />
            {review.meta.body_truncated && <p className="text-xs text-fg-3">The description was cut short by GitHub. Read the rest on the pull request.</p>}
          </>
        ) : (
          <p className="text-sm text-fg-3">{review.kind === "local" ? "A local review has no description." : "The author wrote no description."}</p>
        ))}
      {section === "conversation" &&
        (conversation.length ? (
          <ul className="flex flex-col gap-3">
            {conversation.map((c, i) => (
              <Item key={i} item={c} now={now} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-3">No comments or reviews yet.</p>
        ))}
      {section === "checks" &&
        (checks.length ? (
          <ul className="flex flex-col">
            {checks.map((c, i) => (
              <li key={i} className="flex min-h-ctl-sm items-center gap-2 text-sm">
                <ChecksMark state={checksState(c.bucket)} />
                <span className="min-w-0 truncate text-fg">{c.name}</span>
                {c.workflow && <span className="min-w-0 truncate text-xs text-fg-3">{c.workflow}</span>}
                <span className="ml-auto shrink-0 text-xs text-fg-3">{c.state.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-3">{review.kind === "local" ? "A local review has no checks." : "No checks ran on this pull request."}</p>
        ))}
      {section === "commits" && (
        <ul className="flex flex-col">
          {review.meta.commits.map((c) => (
            <li key={c.sha} className="flex min-h-ctl-sm items-baseline gap-2 text-sm">
              <code className="shrink-0 font-mono text-xs text-fg-3">{c.sha.slice(0, 7)}</code>
              <span className="min-w-0 truncate text-fg" title={c.subject}>
                {c.subject}
              </span>
              <span className="ml-auto shrink-0 text-xs text-fg-3">
                {c.author} · {timeAgo(c.date, now)}
              </span>
            </li>
          ))}
          {review.meta.commits.length === 0 && <li className="text-sm text-fg-3">{plural(0, "commit")}.</li>}
        </ul>
      )}
    </section>
  );
}
