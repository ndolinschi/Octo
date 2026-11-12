import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../lib/cn";
import { useRowKeys } from "../../lib/hooks";
import type { ProviderGroupView, ProviderRowView } from "../../lib/providers";
import { Glyph } from "../primitives/Glyph";
import { ProviderMark } from "../primitives/ProviderMark";
import { StateDot } from "./parts";

const ROW = "flex h-10 w-full items-center gap-3 px-3 text-left press-row focus-inset hover:bg-hover";

/**
 * Decision 89 a-c: the list column. Rows are one height (name, one dim status line), nothing in them but a state dot at a
 * fixed x, the mark and the text; the whole row selects. "Not set up" folds to one summary row while something is connected.
 */
export function ProviderList(props: {
  groups: readonly ProviderGroupView[];
  selectedId: string | undefined;
  onSelect(id: string): void;
  onExpand(open: boolean): void;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  return (
    <div
      ref={list}
      role="group"
      aria-label="Providers"
      className={cn("flex flex-col overflow-hidden rounded-lg border border-panel-edge bg-panel py-1 shadow-panel", props.className)}
    >
      {props.groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.label} className="flex flex-col">
          <h3 className="flex h-8 items-center px-3 text-xs text-fg-3">{g.label}</h3>
          {g.rows.map((r) => (
            <Row key={r.id} row={r} selected={r.id === props.selectedId} onSelect={() => props.onSelect(r.id)} />
          ))}
          {g.foldedLabel && (
            <button type="button" data-row aria-expanded={false} onClick={() => props.onExpand(true)} className={cn(ROW, "text-sm text-fg-2")}>
              <Glyph icon={ChevronRight} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{g.foldedLabel}</span>
            </button>
          )}
          {g.foldable && (
            <button type="button" data-row aria-expanded onClick={() => props.onExpand(false)} className={cn(ROW, "text-sm text-fg-3")}>
              <Glyph icon={ChevronDown} size={14} className="shrink-0" />
              Show fewer
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Row({ row, selected, onSelect }: { row: ProviderRowView; selected: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      data-row
      id={`row-provider-${row.id}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(ROW, selected && "bg-active hover:bg-active")}
    >
      <StateDot tone={row.tone} />
      <ProviderMark id={row.id} label={row.label} className="text-fg-2" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm leading-5 text-fg">
          <span className="min-w-0 truncate">{row.label}</span>
          {row.experimental && <span className="shrink-0 text-xs text-fg-3">Experimental</span>}
        </span>
        <span className="truncate text-xs leading-4 text-fg-3">{row.status}</span>
      </span>
    </button>
  );
}
