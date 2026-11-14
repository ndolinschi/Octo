import { Check, Copy } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useCopy, useScrollFade } from "../../lib/hooks";
import { FOLD_ROWS, numericColumns, toCsv, toMarkdown, type Table } from "../../lib/table";
import { Button } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";

const cellText = (el: Element) => el.textContent.trim();

/**
 * Decision 44 — one table component for Markdown tables in answers and tabular tool results: hairline rows, the header
 * in `fg-2` medium, numeric columns right-aligned with tabular figures, 32px rows, the first column sticky while the
 * table scrolls sideways inside its own box (the page never does), a footer with the row count — "Show all N rows"
 * above 12 — and "Copy" (Markdown / CSV), which shows on hover or focus. `children` are the table's sections.
 */
export function TableFrame({ children, tone = "panel", note }: { children: ReactNode; tone?: "panel" | "code"; note?: string }) {
  const table = useRef<HTMLTableElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useScrollFade(scroller, "x");
  const [rows, setRows] = useState(0);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, copy] = useCopy();
  // The row count is read from the rendered table (Markdown hands over its sections as children).
  useLayoutEffect(() => {
    setRows(table.current?.tBodies[0]?.rows.length ?? 0);
  }, [children]);
  const read = () => {
    const t = table.current;
    const head = t ? [...t.querySelectorAll("thead th")].map(cellText) : [];
    const body = t ? [...(t.tBodies[0]?.rows ?? [])].map((r) => [...r.cells].map(cellText)) : [];
    return { head, body };
  };
  const copyAs = (format: "md" | "csv") => {
    const { head, body } = read();
    copy(format === "md" ? toMarkdown(head, body) : toCsv(head, body));
  };
  const folded = rows > FOLD_ROWS && !all;
  return (
    <div data-table className={cn("octo-table-frame group/table", tone === "code" && "octo-table-code")} data-folded={folded || undefined}>
      <div ref={scroller} className="octo-table-scroll" tabIndex={-1}>
        <table ref={table} className="octo-table">
          {children}
        </table>
      </div>
      <div className="flex h-row items-center gap-2 text-xs text-fg-3">
        {rows > FOLD_ROWS ? (
          <Button variant="quiet" size="xs" aria-expanded={all} onClick={() => setAll((x) => !x)} className="-ml-1.5">
            {all ? "Show fewer" : `Show all ${rows} rows`}
          </Button>
        ) : (
          <span className="tabular-nums">
            {rows} {rows === 1 ? "row" : "rows"}
          </span>
        )}
        {note && <span className="min-w-0 truncate">{note}</span>}
        <Button
          ref={button}
          variant="quiet"
          size="xs"
          icon={copied ? Check : Copy}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label="Copy table"
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
          }}
          className={cn(
            "-mr-1.5 ml-auto",
            "opacity-0 group-focus-within/table:opacity-100 group-hover/table:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            (menu !== null || copied) && "opacity-100",
          )}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Copy table"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              { id: "md", label: "Copy as Markdown", run: () => copyAs("md") },
              { id: "csv", label: "Copy as CSV", run: () => copyAs("csv") },
            ]}
          />
        )}
      </Presence>
    </div>
  );
}

/** A parsed table (a tool's CSV or JSON rows) in the same frame. */
export function DataTable({ table, tone = "panel" }: { table: Table; tone?: "panel" | "code" }) {
  const num = numericColumns(table.rows, table.head.length);
  return (
    <TableFrame tone={tone} {...(table.truncated ? { note: `${table.truncated} more in the raw result` } : {})}>
      <thead>
        <tr>
          {table.head.map((h, i) => (
            <th key={i} className={cn(num[i] && "octo-num")}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r, i) => (
          <tr key={i}>
            {table.head.map((_, j) => (
              <td key={j} className={cn(num[j] && "octo-num")}>
                {r[j] ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/** A key–value result (≤ 8 pairs) as a two-column definition list, not a table. */
export function Pairs({ pairs }: { pairs: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 font-mono text-xs leading-5">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-fg-3">{k}</dt>
          <dd className="wrap-anywhere text-fg-2 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
