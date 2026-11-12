import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../lib/cn";
import { useRowKeys } from "../../lib/hooks";
import type { ProviderGroupView, ProviderRowView } from "../../lib/providers";
import { ListFrame } from "../primitives/Card";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ProviderMark } from "../primitives/ProviderMark";
import { SectionHeader } from "../primitives/SectionHeader";
import { StateDot } from "./parts";

/**
 * Decision 89 a-c: the list column. Rows are one height (name, one dim status line), nothing in them but the mark, the text
 * and a state dot at a fixed x (the right edge); the whole row selects. "Not set up" folds to one summary row while
 * something is connected.
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
    <ListFrame {...(props.className ? { className: props.className } : {})}>
      <div ref={list} role="group" aria-label="Providers" className="flex flex-col py-1">
        {props.groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label} className="flex flex-col">
            <SectionHeader as="h3" inset className="px-3">
              {g.label}
            </SectionHeader>
            {g.rows.map((r) => (
              <Row key={r.id} row={r} selected={r.id === props.selectedId} onSelect={() => props.onSelect(r.id)} />
            ))}
            {g.foldedLabel && (
              <ListRow
                size="lg"
                tone="quiet"
                expanded={false}
                title={g.foldedLabel}
                leading={<Glyph icon={ChevronRight} size={14} />}
                onClick={() => props.onExpand(true)}
              />
            )}
            {g.foldable && (
              <ListRow
                size="lg"
                tone="quiet"
                expanded
                title="Show fewer"
                leading={<Glyph icon={ChevronDown} size={14} />}
                onClick={() => props.onExpand(false)}
              />
            )}
          </div>
        ))}
      </div>
    </ListFrame>
  );
}

function Row({ row, selected, onSelect }: { row: ProviderRowView; selected: boolean; onSelect(): void }) {
  return (
    <ListRow
      id={`row-provider-${row.id}`}
      size="lg"
      selected={selected}
      onClick={onSelect}
      leading={<ProviderMark id={row.id} label={row.label} className="text-fg-2" />}
      title={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate">{row.label}</span>
          {row.experimental && <span className={cn("shrink-0 text-xs text-fg-3")}>Experimental</span>}
        </span>
      }
      description={row.status}
      meta={
        <span className="flex">
          <StateDot tone={row.tone} />
        </span>
      }
      className="mx-1"
    />
  );
}
