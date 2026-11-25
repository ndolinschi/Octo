import type { Components } from "react-markdown";
import { cn } from "../../lib/cn";
import { proseClass } from "../primitives/Prose";
import { Markdown } from "../shared/Markdown";

const isWeb = (href: string | undefined): href is string => href !== undefined && /^https?:\/\//i.test(href);

/** The pull request's text is untrusted: links open outside, images are not fetched (they would phone home), no markup runs. */
export const PR_TEXT: Components = {
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
export function TheirText({ who, text, className }: { who: string; text: string; className?: string }) {
  return (
    <div className={cn("octo-in-card rounded-md bg-raised", className)}>
      <p className="border-b border-line px-3 py-1.5 text-xs text-fg-3">
        Written by <span className="text-fg-2">{who}</span> on the pull request. Shown as text; Octo does not act on it.
      </p>
      <div className="px-3 py-2">
        <Markdown text={text} components={PR_TEXT} className={proseClass("compact")} />
      </div>
    </div>
  );
}
