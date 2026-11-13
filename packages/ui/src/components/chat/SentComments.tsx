import { useId, useState } from "react";
import { Button } from "../primitives/Button";
import { linesLabel, type SentComment } from "../../lib/comments";
import { useOptionalCode } from "../../state/code";
import { useHost } from "../../state/host";

const COLLAPSED_LINES = 3;

/**
 * The code comments of a sent message, as compact cards inside the user's prompt box: the file and
 * lines (a link that opens the file there), the quoted lines in mono (three, then "Show all"),
 * and the comment. Never the raw `octo-comments` block.
 */
export function SentComments({ comments }: { comments: SentComment[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {comments.map((c, i) => (
        <CommentCard key={i} comment={c} />
      ))}
    </ul>
  );
}

function CommentCard({ comment: c }: { comment: SentComment }) {
  const code = useOptionalCode();
  const { openFile } = useHost();
  const [expanded, setExpanded] = useState(false);
  const quoteId = useId();
  const where = linesLabel(c.start, c.end);
  const full = `${c.folder}/${c.path}`;
  const known = code?.folders.some((f) => f.label === c.folder) ?? false;
  const canOpen = Boolean(openFile) || known;
  const lines = expanded ? c.quote : c.quote.slice(0, COLLAPSED_LINES);
  const hidden = c.quote.length - COLLAPSED_LINES;
  const width = String(c.start + c.quote.length - 1).length;

  const open = () => {
    if (openFile) return openFile(c.path, c.folder);
    code?.openFile(c.folder, c.path, { line: c.start, endLine: c.end });
  };

  return (
    <li className="overflow-hidden rounded-sm border border-line bg-panel">
      <div className="flex min-h-8 items-center gap-2 px-3 py-1 text-xs">
        {canOpen ? (
          <Button variant="link" tone="quiet" mono size="xs" onClick={open} aria-label={`Open ${full} at ${where}`} title={full} className="min-w-0 truncate">
            {c.path}
          </Button>
        ) : (
          <span className="min-w-0 truncate font-mono text-fg-2" title={full}>
            {c.path}
          </span>
        )}
        <span className="shrink-0 text-fg-3 tabular-nums">{where.replace(/^l/, "L")}</span>
      </div>
      {c.quote.length > 0 && (
        <div className="border-t border-line bg-code-bg">
          <pre id={quoteId} className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-fg-2">
            {lines.map((line, i) => (
              <span key={i} className="block">
                <span aria-hidden className="mr-3 inline-block text-right text-fg-3 tabular-nums select-none" style={{ width: `${width}ch` }}>
                  {c.start + i}
                </span>
                {line || " "}
              </span>
            ))}
            {(expanded || hidden <= 0) && c.truncated && <span className="block text-fg-3">…</span>}
          </pre>
          {hidden > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={quoteId}
              onClick={() => setExpanded((x) => !x)}
              className="mb-1 ml-1.5 inline-flex h-6 press items-center rounded-sm px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-fg"
            >
              {expanded ? "Show less" : `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`}
            </button>
          )}
        </div>
      )}
      {c.text && <p className="border-t border-line px-3 py-2 text-base wrap-anywhere whitespace-pre-wrap text-fg">{c.text}</p>}
    </li>
  );
}
