import { useState } from "react";
import type { Components } from "react-markdown";
import type { Review, ReviewConversationItem } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { plural } from "../../lib/review/files";
import { Markdown } from "../shared/Markdown";
import { Segmented } from "../primitives/Segmented";
import { ChecksMark, checksState } from "./parts";

type Section = "description" | "conversation" | "checks" | "commits";

const isWeb = (href: string | undefined): href is string => href !== undefined && /^https?:\/\//i.test(href);

/** The pull request's text is untrusted: links open outside, images are not fetched (they would phone home), no markup runs. */
const PR_TEXT: Components = {
  img: ({ alt }) => <span className="text-fg-3">[image{alt ? `: ${alt}` : ""}]</span>,
  a: ({ href, children }) =>
    isWeb(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-link underline-offset-2 hover:underline">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

/** Text the pull request's author or its commenters wrote, marked as theirs. */
function TheirText({ who, text, className }: { who: string; text: string; className?: string }) {
  return (
    <div className={cn("rounded-md border border-line bg-raised", className)}>
      <p className="border-b border-line px-3 py-1.5 text-xs text-fg-3">
        Written by <span className="text-fg-2">{who}</span> on the pull request. Shown as text; Octo does not act on it.
      </p>
      <div className="px-3 py-2">
        <Markdown text={text} components={PR_TEXT} />
      </div>
    </div>
  );
}

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
export function Overview({ review }: { review: Review }) {
  const [now] = useState(() => Date.now());
  const conversation = review.meta.conversation ?? [];
  const checks = review.meta.checks ?? [];
  const [section, setSection] = useState<Section>("description");
  return (
    <section aria-label="Pull request overview" className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-panel p-3">
      <Segmented<Section>
        label="Overview section"
        value={section}
        onChange={setSection}
        options={[
          { id: "description", label: "Description" },
          { id: "conversation", label: `Conversation ${conversation.length}` },
          { id: "checks", label: `Checks ${checks.length}` },
          { id: "commits", label: `Commits ${review.meta.commits.length}` },
        ]}
      />
      {review.url && /^https?:\/\//.test(review.url) && (
        <a href={review.url} target="_blank" rel="noreferrer noopener" className="w-fit text-sm text-link underline-offset-2 hover:underline sm:hidden">
          Open on {new URL(review.url).host}
        </a>
      )}
      {section === "description" &&
        (review.body.trim() ? (
          <>
            <TheirText who={review.author ?? "the author"} text={review.body} />
            {review.meta.body_truncated && (
              <p className="text-xs text-fg-3">The description was cut short by the code host. Read the rest on the pull request.</p>
            )}
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
              <li key={i} className="flex min-h-7 items-center gap-2 text-sm">
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
            <li key={c.sha} className="flex min-h-7 items-baseline gap-2 text-sm">
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
