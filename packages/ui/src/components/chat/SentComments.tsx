import { memo, useId, useMemo, useState } from "react";
import { linesLabel, type SentComment } from "../../lib/comments";
import { dedentQuote } from "./dedentQuote";
import { fileName } from "../../lib/files";
import { useOptionalCode } from "../../state/code";
import { useHost } from "../../state/host";
import { Button } from "../primitives/Button";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";

const COLLAPSED_LINES = 3;

/**
 * The code comments of a sent message, rendered inside `[data-bubble][data-has-cards]`: each entry pairs a recessed
 * code-reference card (`bg-panel` / `bg-code-bg`, concentric `rounded-md`) with the user's comment text sitting cleanly
 * below it on the bubble's own surface. Never renders the raw `octo-comments` fence.
 */
export const SentComments = memo(function SentComments({ comments }: { comments: SentComment[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {comments.map((c, i) => (
        <CommentCard key={`${c.folder}/${c.path}:${c.start}-${c.end}:${i}`} comment={c} />
      ))}
    </ul>
  );
});

const CommentCard = memo(function CommentCard({ comment: c }: { comment: SentComment }) {
  const code = useOptionalCode();
  const { openFile } = useHost();
  const [expanded, setExpanded] = useState(false);
  const quoteId = useId();
  const where = linesLabel(c.start, c.end);
  const full = `${c.folder}/${c.path}`;
  const known = code?.folders.some((f) => f.label === c.folder) ?? false;
  const canOpen = Boolean(openFile) || known;
  const dedented = useMemo(() => dedentQuote(c.quote), [c.quote]);
  const lines = expanded ? dedented : dedented.slice(0, COLLAPSED_LINES);
  const hidden = dedented.length - COLLAPSED_LINES;
  const width = String(c.start + dedented.length - 1).length;
  const icon = fileIcon(fileName(c.path));

  const open = () => {
    if (openFile) return openFile(c.path, c.folder);
    code?.openFile(c.folder, c.path, { line: c.start, endLine: c.end });
  };

  return (
    <li className="flex flex-col">
      {/* Polish step 3, C3: a block inside the request bubble is the recessed tone, never an outline of its own. */}
      <div className="overflow-hidden rounded-md bg-panel">
        <div className="flex min-h-ctl-sm items-center justify-between gap-3 px-3 py-1 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <Glyph icon={icon} size={14} className="shrink-0 text-fg-3" />
            {canOpen ? (
              <Button
                variant="link"
                tone="quiet"
                mono
                size="xs"
                onClick={open}
                aria-label={`Open ${full} at ${where}`}
                title={full}
                className="max-w-full min-w-0"
              >
                <span className="truncate">{c.path}</span>
              </Button>
            ) : (
              <span className="min-w-0 truncate font-mono text-fg-2" title={full}>
                {c.path}
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-fg-3 tabular-nums">{where.replace(/^l/, "L")}</span>
        </div>
        {dedented.length > 0 && (
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
              <Button
                variant="quiet"
                size="xs"
                aria-expanded={expanded}
                aria-controls={quoteId}
                onClick={() => setExpanded((x) => !x)}
                className="mb-1 ml-1.5 text-fg-3"
              >
                {expanded ? "Show less" : `Show ${hidden}\u00a0more ${hidden === 1 ? "line" : "lines"}`}
              </Button>
            )}
          </div>
        )}
      </div>
      {c.text && <p className="px-2 pt-2 pb-1 wrap-anywhere whitespace-pre-wrap text-fg">{c.text}</p>}
    </li>
  );
});
