import { useMemo, useState } from "react";
import { cn } from "../../../lib/cn";
import { foldedRows, previewRows, type DiffRow } from "../../../lib/toolView";
import { Button } from "../../primitives/Button";
import { Disclosure } from "./parts";

type Row = DiffRow | { kind: "gap"; lines: number };

/**
 * retest3 G2: a compact inline diff — the first `max` changed rows with a little context, +/− gutters and the file's line numbers
 * when known. "Show all" expands in place (long unchanged runs fold to a gap; at most 2000 rows). A line number opens the file
 * at that line. Plain text with the diff tints: no editor, no highlighter (the conversation stays light).
 */
export function DiffPreview(props: {
  rows: readonly DiffRow[];
  /** Line numbers are the file's; otherwise the numbers column is left out (a snippet whose place is unknown). */
  numbered: boolean;
  max?: number;
  onLine?: ((line: number) => void) | undefined;
  /** Controlled "Show all" (the turn's Expand all). */
  all?: boolean;
  label: string;
}) {
  const [inner, setInner] = useState(false);
  const all = props.all ?? inner;
  const max = props.max ?? 12;
  const preview = useMemo(() => previewRows(props.rows, max, 2), [props.rows, max]);
  const full = useMemo(() => (all ? foldedRows(props.rows) : null), [all, props.rows]);
  const rows: readonly Row[] = full ? full.rows : preview.rows;
  const more = preview.rest > 0 || preview.rows.length < foldedLength(props.rows);
  const width = props.numbered ? String(Math.max(...props.rows.map((r) => Math.max(r.old ?? 0, r.new ?? 0)), 1)).length : 0;
  return (
    <div data-diff-preview className="flex min-w-0 flex-col">
      <div role="group" aria-label={props.label} className="octo-diff overflow-x-auto font-mono text-xs leading-5">
        <div className="min-w-max">
          {rows.map((r, i) =>
            r.kind === "gap" ? (
              <div key={i} className="octo-diff-gap pl-3 text-fg-3 select-none">
                <span className="font-sans">
                  ⋯ {r.lines} unchanged line{r.lines === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <Line key={i} row={r} width={width} onLine={props.onLine} />
            ),
          )}
          {full && full.cut > 0 && <div className="pl-3 font-sans text-fg-3">{full.cut} more rows are not shown here. Open the diff to see them.</div>}
        </div>
      </div>
      {more && props.all === undefined && (
        <div className="px-2 pt-1">
          <Disclosure open={all} onToggle={() => setInner((x) => !x)}>
            {all ? "Show less" : preview.rest > 0 ? `Show all (${preview.rest} more changed line${preview.rest === 1 ? "" : "s"})` : "Show all"}
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function foldedLength(rows: readonly DiffRow[]): number {
  return previewRows(rows, Number.POSITIVE_INFINITY, 2).rows.length;
}

function Line({ row, width, onLine }: { row: DiffRow; width: number; onLine?: ((line: number) => void) | undefined }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const target = row.new ?? row.old;
  return (
    <div data-kind={row.kind} className="octo-diff-row flex pr-3">
      {width > 0 && (
        <>
          <span className="octo-diff-num" style={{ width: `${width + 1}ch` }}>
            {row.old ?? ""}
          </span>
          {onLine && target !== null ? (
            <Button
              variant="link"
              tone="quiet"
              mono
              size="xs"
              className="octo-diff-num octo-diff-go justify-end"
              style={{ width: `${width + 1}ch` }}
              title={`Go to line ${target}`}
              aria-label={`Go to line ${target}`}
              onClick={() => onLine(target)}
            >
              {row.new ?? ""}
            </Button>
          ) : (
            <span className="octo-diff-num" style={{ width: `${width + 1}ch` }}>
              {row.new ?? ""}
            </span>
          )}
        </>
      )}
      <span className={cn("octo-diff-sign", width === 0 && "pl-3")}>{sign}</span>
      <span className="whitespace-pre">{row.text || " "}</span>
    </div>
  );
}
