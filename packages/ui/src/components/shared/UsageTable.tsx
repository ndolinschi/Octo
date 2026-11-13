import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import { costCellText, usageCsv, usageTotals, type RoleRow, type UsageRow, type UsageTotals } from "../../lib/usage/model";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";

/** A table row: a model, agent, day or project; `nested` rows (roles, a project's models) sit under it, dimmer. */
export type UsageTableRow = UsageRow & {
  nested?: readonly RoleRow[];
  /** The row can be opened (a project in Settings); `open` and `onToggle` drive it, `nestedNote` stands in while its rows load. */
  expandable?: boolean;
  open?: boolean;
  nestedNote?: string;
};

/** Narrow containers (decision 86, below the list floor) fold the token columns under the name. */
const WIDE = "@max-xl/utable:hidden";
const TH = "h-row px-2 text-right text-xs font-normal text-fg-3 whitespace-nowrap";
const TD = "px-2 text-right tabular-nums whitespace-nowrap";

function pct(share: number): string {
  return `${(share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0)}%`;
}

function tokenTitle(n: number, what: string): string {
  return `${n.toLocaleString()} ${what}`;
}

/** The cost as text; "no price" is dotted-underlined and says in its tooltip why and what to do (decision 90: a state explains itself). */
function CostText({ r }: { r: UsageRow }) {
  const text = costCellText(r.cost);
  if (r.cost.spent !== null) return <>{text}</>;
  return (
    <span title={costTitle(r)} className="cursor-help underline decoration-dotted underline-offset-2">
      {text}
    </span>
  );
}

function detail(r: UsageRow) {
  return (
    <>
      {[`${formatTokens(r.input)} in`, `${formatTokens(r.cached)} cached`, `${formatTokens(r.output)} out`].join(" · ")} · <CostText r={r} />
    </>
  );
}

function Cells({ r, dim }: { r: UsageRow; dim?: boolean }) {
  const est = r.tokensEstimated ? " (some counts are estimated)" : "";
  return (
    <>
      <td className={cn(TD, WIDE)} title={tokenTitle(r.input, "input tokens")}>
        {formatTokens(r.input)}
      </td>
      <td className={cn(TD, WIDE)} title={tokenTitle(r.cached, "cached tokens (cache reads and writes)")}>
        {formatTokens(r.cached)}
      </td>
      <td className={cn(TD, WIDE)} title={tokenTitle(r.output, "output tokens")}>
        {formatTokens(r.output)}
      </td>
      <td className={cn(TD, !dim && "text-fg")} title={`${tokenTitle(r.total, "tokens")}${est}`}>
        {r.tokensEstimated && <span className="text-fg-3">~</span>}
        {formatTokens(r.total)}
      </td>
      <td className={cn(TD, WIDE)} title={tokenTitle(r.requests, r.requests === 1 ? "request" : "requests")}>
        {r.requests.toLocaleString()}
      </td>
      <td
        className={cn(TD, WIDE, (r.cost.spent === null || (r.cost.equivalent > 0 && !r.cost.spent)) && "text-fg-3")}
        title={r.cost.spent === null ? undefined : costTitle(r)}
      >
        <CostText r={r} />
      </td>
    </>
  );
}

function costTitle(r: UsageRow): string {
  if (r.cost.spent === null) {
    const none = "No price for this model, so its cost is not counted. Add the model to prices.toml in the harness data directory.";
    return r.cost.equivalent > 0 ? `${none} The subscription part is not spend.` : none;
  }
  if (r.cost.equivalent > 0) return `${costCellText(r.cost)}: the subscription part is not spend`;
  return `$${r.cost.spent.toFixed(4)}${r.cost.estimated ? " (estimated from the price table)" : " (reported by the source)"}`;
}

function Bar({ share }: { share: number }) {
  return (
    <td className={cn("w-16 px-2", WIDE)} title={`${pct(share)} of the tokens`}>
      {/* 4px tall; the track is the `active` fill and the bar `fg-2`, so both read in dark and light; 2px at least. */}
      <span aria-hidden className="block h-1 w-12 rounded-full bg-active">
        <span className="block h-full min-w-0.5 rounded-full bg-fg-2" style={{ width: `${share * 100}%` }} />
      </span>
    </td>
  );
}

function Body({ r, nested, onToggle }: { r: UsageTableRow; nested: boolean; onToggle?: ((key: string) => void) | undefined }) {
  const dim = nested;
  return (
    <tr className={cn("h-row border-t border-line first:border-t-0", dim && "text-fg-3")}>
      <td className={cn("w-full max-w-0 px-2 text-left", nested && "pl-6")}>
        <div className="flex min-w-0 items-center gap-1">
          {r.expandable && (
            <IconButton
              icon={r.open ? ChevronDown : ChevronRight}
              label={`${r.open ? "Collapse" : "Expand"} ${r.label}`}
              size="xs"
              aria-expanded={r.open === true}
              className="-ml-1"
              onClick={() => onToggle?.(r.key)}
            />
          )}
          <span className={cn("min-w-0 truncate", !dim && "text-fg")} title={r.key === r.label ? r.label : `${r.label} (${r.key})`}>
            {r.label}
          </span>
        </div>
        <span className="hidden pb-1 text-xs text-fg-3 tabular-nums @max-xl/utable:block">{detail(r)}</span>
      </td>
      <Cells r={r} dim={dim} />
      <Bar share={r.share} />
    </tr>
  );
}

/**
 * Decision 86 a: one table, a row per model / agent / day / project — Input · Cached · Output · Total · Requests · Cost
 * and a share bar, a totals row that is the sum of the rows shown, compact numbers with the full value in the tooltip,
 * and "Copy as CSV" (e). Below the list floor (container 36rem) only Total stays a column; the three token numbers and the
 * cost go under the name.
 */
export function UsageTable({
  first,
  label,
  rows,
  onToggle,
  note,
  footer,
}: {
  first: string;
  label: string;
  rows: readonly UsageTableRow[];
  onToggle?: (key: string) => void;
  /** A quiet line left of "Copy as CSV". */
  note?: ReactNode;
  footer?: ReactNode;
}) {
  const totals: UsageTotals = useMemo(() => usageTotals(rows), [rows]);
  const [copied, copy] = useCopy();
  const csv = () =>
    usageCsv(
      first,
      rows.flatMap((row) => [{ row }, ...(row.nested ?? []).map((n) => ({ row: n, parent: row.label }))]),
      totals,
    );
  return (
    <div className="@container/utable flex min-w-0 flex-col">
      <table aria-label={label} className="w-full table-auto border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="h-row w-full px-2 text-left text-xs font-normal text-fg-3">
              {first}
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Input
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Cached
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Output
            </th>
            <th scope="col" className={TH}>
              Total
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Requests
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Cost
            </th>
            <th scope="col" aria-label="Share" className={cn("w-16", WIDE)} />
          </tr>
        </thead>
        {rows.map((r) => (
          <tbody key={r.key} className="border-t border-line first:border-t-0">
            <Body r={r} nested={false} onToggle={onToggle} />
            {(r.expandable ? r.open : true) && r.nestedNote && (
              <tr className="h-row text-fg-3">
                <td colSpan={8} className="px-2 pl-6 text-xs">
                  {r.nestedNote}
                </td>
              </tr>
            )}
            {(r.expandable ? r.open : true) && (r.nested ?? []).map((n) => <Body key={n.key} r={n} nested onToggle={undefined} />)}
          </tbody>
        ))}
        <tfoot>
          <tr className="h-row border-t border-line font-medium">
            <th scope="row" className="px-2 text-left font-medium text-fg">
              Total
            </th>
            <Cells r={{ ...totals, key: "total", label: "Total", share: 1 }} />
            <td className={WIDE} />
          </tr>
        </tfoot>
      </table>
      <div className="flex h-row items-center gap-2 px-2 text-xs text-fg-3">
        <span className="min-w-0 truncate">{note}</span>
        <Button variant="quiet" size="xs" icon={copied ? Check : Copy} className="-mr-1.5 ml-auto" onClick={() => copy(csv())}>
          {copied ? "Copied" : "Copy as CSV"}
        </Button>
      </div>
      {footer}
    </div>
  );
}
