import { useMemo, useRef, type CSSProperties } from "react";
import { useScrollFade } from "../../../lib/hooks";
import { foldedRows, leadingColumns, previewRows, type DiffRow } from "../../../lib/toolView";
import { Button } from "../../primitives/Button";
import { ScrollArea } from "../../primitives/ScrollArea";

type Row = DiffRow | { kind: "gap"; lines: number };

/** Rows of the compact preview before "Show all". */
export const PREVIEW_ROWS = 12;

/** How much the compact preview leaves out of `sections` (the body's "Show all (N more changed lines)"). */
export function diffMore(sections: readonly (readonly DiffRow[])[], max = PREVIEW_ROWS): { more: boolean; rest: number } {
  let rest = 0;
  let more = false;
  for (const rows of sections) {
    const p = previewRows(rows, max, 2);
    rest += p.rest;
    if (p.rest > 0 || p.rows.length < previewRows(rows, Number.POSITIVE_INFINITY, 2).rows.length) more = true;
  }
  return { more, rest };
}

/**
 * retest3 G2 (toolpolish): the inline diff — one grid for every row of every diff: [old no.][new no.][sign][code]. The number
 * columns are as wide as the largest number in the diff (tabular, right-aligned), the sign has its own 1ch column, code starts
 * on one edge. Unchanged rows show both numbers, removed rows the old, added rows the new. The gutter stays put while the code
 * scrolls sideways (never wrapped); the scroller's ends fade when there is more. Several `sections` (edits of one file) share
 * the columns, a gap row between them. Plain text: no editor, no highlighter.
 */
export function DiffPreview(props: {
  sections: readonly (readonly DiffRow[])[];
  /** Line numbers are the file's; otherwise only the sign column (a snippet whose place is unknown). */
  numbered: boolean;
  /** Every row (long unchanged runs folded), not the compact preview. */
  all: boolean;
  onLine?: ((line: number) => void) | undefined;
  label: string;
}) {
  const { sections, all } = props;
  const rows = useMemo(() => {
    const out: Row[] = [];
    let cut = 0;
    sections.forEach((s, i) => {
      if (i > 0) out.push({ kind: "gap", lines: gapBetween(sections[i - 1] ?? [], s) });
      if (all) {
        const f = foldedRows(s);
        out.push(...f.rows);
        cut += f.cut;
      } else out.push(...previewRows(s, PREVIEW_ROWS, 2).rows);
    });
    return { rows: out, cut };
  }, [sections, all]);
  const digits = props.numbered ? String(Math.max(1, ...sections.flatMap((s) => s.map((r) => Math.max(r.old ?? 0, r.new ?? 0))))).length : 0;
  const scroller = useRef<HTMLDivElement>(null);
  useScrollFade(scroller, "x");
  const style = { "--diff-digits": `${digits}ch` } as CSSProperties;
  return (
    <ScrollArea
      axis="x"
      ref={scroller}
      role="region"
      tabIndex={0}
      aria-label={props.label}
      data-diff-preview
      data-numbered={props.numbered ? "" : undefined}
      className="octo-diff font-mono text-xs leading-5"
      style={style}
    >
      <div className="octo-diff-rows">
        {rows.rows.map((r, i) =>
          r.kind === "gap" ? (
            <Gap key={i} lines={r.lines} numbered={props.numbered} />
          ) : (
            <Line key={i} row={r} numbered={props.numbered} onLine={props.onLine} />
          ),
        )}
        {rows.cut > 0 && <Gap lines={0} numbered={props.numbered} text={`${rows.cut} more rows are not shown here. Open the diff to see them.`} />}
      </div>
    </ScrollArea>
  );
}

/** Lines between two placed sections (0 when unknown or overlapping: the gap row then says only "⋯"). */
function gapBetween(a: readonly DiffRow[], b: readonly DiffRow[]): number {
  const end = a.reduce((n, r) => Math.max(n, r.new ?? 0), 0);
  const start = b.find((r) => r.new !== null)?.new ?? 0;
  return end > 0 && start > end + 1 ? start - end - 1 : 0;
}

function Gap({ lines, numbered, text }: { lines: number; numbered: boolean; text?: string }) {
  return (
    <div className="octo-diff-row" data-kind="gap">
      <span className="octo-diff-gutter" aria-hidden>
        {numbered && <span className="octo-diff-num" />}
        {numbered && <span className="octo-diff-num">⋯</span>}
        <span className="octo-diff-sign" />
      </span>
      <span className="octo-diff-code font-sans">{text ?? (lines > 0 ? `${lines} unchanged line${lines === 1 ? "" : "s"}` : "")}</span>
    </div>
  );
}

function Line({ row, numbered, onLine }: { row: DiffRow; numbered: boolean; onLine?: ((line: number) => void) | undefined }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
  const target = row.new;
  return (
    <div data-kind={row.kind} className="octo-diff-row">
      <span className="octo-diff-gutter">
        {numbered && <span className="octo-diff-num">{row.old ?? ""}</span>}
        {numbered &&
          (onLine && target !== null ? (
            <Button
              variant="link"
              tone="quiet"
              mono
              size="xs"
              className="octo-diff-num octo-diff-go"
              title={`Go to line ${target}`}
              aria-label={`Go to line ${target}`}
              onClick={() => onLine(target)}
            >
              {target}
            </Button>
          ) : (
            <span className="octo-diff-num">{row.new ?? ""}</span>
          ))}
        <span className="octo-diff-sign">{sign}</span>
      </span>
      {/* A7.2: on the phone a wrapped line hangs under its own indentation (styles.css, `--diff-lead`). */}
      <span className="octo-diff-code" style={{ "--diff-lead": `${leadingColumns(row.text)}ch` } as CSSProperties}>
        {row.text || " "}
      </span>
    </div>
  );
}
