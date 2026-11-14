import { useState } from "react";
import { cn } from "../../../lib/cn";
import { splitLines, type ReadTarget } from "../../../lib/toolView";
import { BodyFrame, INSET, TextAction, useOpenAt, type RawCall } from "./parts";

/** At most this many lines of a read's content are drawn when shown (the editor has the rest). */
const CONTENT_CAP = 400;

/**
 * retest3 G1 (toolpolish): a read — the row says the file; the body's action line says which lines it covered and how many came
 * back, with "Open at line N" and "Show content" (what it returned, folded by default). A failed read says why in one line.
 */
export function ReadBody({ target, content, failed, raw }: { target: ReadTarget; content: string | null; failed: string | null; raw: RawCall }) {
  const open = useOpenAt();
  const [show, setShow] = useState(false);
  const lines = content !== null && !failed ? splitLines(content) : [];
  // A read past the end of a file covers only the lines it returned ("1–40" of a 30-line file reads "1–30").
  const end = target.start !== null && target.end !== null && lines.length > 0 ? Math.min(target.end, target.start + lines.length - 1) : target.end;
  const range = target.start === null ? "The whole file" : end !== null && end !== target.start ? `Lines ${target.start}–${end}` : `Line ${target.start}`;
  const at = target.start ? { line: target.start, ...(end ? { endLine: end } : {}) } : undefined;
  return (
    <BodyFrame
      kind="read"
      raw={raw}
      lead={
        <>
          <span>{range}</span>
          {lines.length > 0 && target.start === null && (
            <span>
              · {lines.length} line{lines.length === 1 ? "" : "s"}
            </span>
          )}
        </>
      }
      actions={
        <>
          {lines.length > 0 && <TextAction onClick={() => setShow((s) => !s)}>{show ? "Hide content" : "Show content"}</TextAction>}
          {open && <TextAction onClick={() => open(target.path, target.folder, at)}>{target.start ? `Open at line ${target.start}` : "Open file"}</TextAction>}
        </>
      }
    >
      {(failed || show) && (
        <>
          {failed && <p className={cn(INSET, "text-err")}>{failed}</p>}
          {show && (
            <pre className="max-h-80 overflow-auto px-3 py-2 font-mono leading-5 whitespace-pre text-fg-2">
              {lines.slice(0, CONTENT_CAP).join("\n")}
              {lines.length > CONTENT_CAP && `\n… ${lines.length - CONTENT_CAP} more lines: open the file to read them.`}
            </pre>
          )}
        </>
      )}
    </BodyFrame>
  );
}
