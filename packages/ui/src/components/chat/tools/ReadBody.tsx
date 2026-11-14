import { useState } from "react";
import { cn } from "../../../lib/cn";
import { readLabel, splitLines, type ReadTarget } from "../../../lib/toolView";
import { Button } from "../../primitives/Button";
import { Disclosure, FRAME, INSET, useOpenAt, useShownPath } from "./parts";

/** At most this many lines of a read's content are drawn when shown (the editor has the rest). */
const CONTENT_CAP = 400;

/**
 * retest3 G1: a read is `path:lines` as a link that opens the file at those lines; what it returned stays folded ("Show what it
 * read"). A failed read says why in one line.
 */
export function ReadBody({ target, content, failed }: { target: ReadTarget; content: string | null; failed: string | null }) {
  const open = useOpenAt();
  const shown = useShownPath(target.path, target.folder);
  const [show, setShow] = useState(false);
  const lines = content !== null && !failed ? splitLines(content) : [];
  // A read past the end of a file covers only the lines it returned ("1–40" of a 30-line file reads "1–30").
  const end = target.start !== null && target.end !== null && lines.length > 0 ? Math.min(target.end, target.start + lines.length - 1) : target.end;
  const label = readLabel({ ...target, end, path: shown });
  const at = target.start ? { line: target.start, ...(end ? { endLine: end } : {}) } : undefined;
  return (
    <div data-tool-body="read" className={FRAME}>
      <div className={cn("flex min-w-0 items-center gap-3", INSET)}>
        {open ? (
          <Button
            variant="link"
            tone="quiet"
            mono
            size="xs"
            className="min-w-0 shrink truncate"
            title={`Open ${label}`}
            onClick={() => open(target.path, target.folder, at)}
          >
            <span className="truncate">{label}</span>
          </Button>
        ) : (
          <span className="min-w-0 truncate font-mono text-fg-2">{label}</span>
        )}
        {lines.length > 0 && (
          <span className="shrink-0 text-fg-3 tabular-nums">
            {lines.length} line{lines.length === 1 ? "" : "s"}
          </span>
        )}
        {lines.length > 0 && (
          <span className="ml-auto shrink-0">
            <Disclosure open={show} onToggle={() => setShow((s) => !s)}>
              {show ? "Hide content" : "Show content"}
            </Disclosure>
          </span>
        )}
      </div>
      {failed && <p className="border-t border-line px-3 py-2 text-err">{failed}</p>}
      {show && (
        <pre className="max-h-80 overflow-auto border-t border-line px-3 py-2 font-mono leading-5 whitespace-pre text-fg-2">
          {lines.slice(0, CONTENT_CAP).join("\n")}
          {lines.length > CONTENT_CAP && `\n… ${lines.length - CONTENT_CAP} more lines: open the file to read them.`}
        </pre>
      )}
    </div>
  );
}
