import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../../lib/cn";
import { useRowKeys } from "../../../lib/hooksMore";
import { useRovingRows } from "../../../lib/rovingRows";
import type { ProviderGroupView, ProviderRowView, Tone } from "../../../lib/providers";
import { Glyph } from "../../primitives/Glyph";
import { ListRow } from "../../primitives/ListRow";
import { ProviderMark } from "../../primitives/ProviderMark";
import { SectionHeader } from "../../primitives/SectionHeader";

/** The state dot of a provider row, at a fixed x (decision 89 a). The tone is carried by this dot alone (decision 91k). */
export function ToneDot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "err" ? "bg-err" : "bg-fg-3")}
    />
  );
}

/**
 * Decisions 89 a-c and 91b: the providers list shared by Settings → Providers and the connect screen. Groups with a caption,
 * rows of one height (`ListRow`: name, one dim status line, a state dot), the whole row selects; nothing else in a row. "Not set
 * up" folds into one summary row while something is connected.
 */
export function ProviderRows(props: {
  groups: readonly ProviderGroupView[];
  selectedId: string | undefined;
  onSelect(id: string): void;
  onExpand(open: boolean): void;
  /** `false`: no border and fill of its own (it sits in a frame that has them, as on the connect screen). */
  framed?: boolean;
  /** Nothing opened yet: in one column (the list alone) no row reads as chosen (polish step 6a, S7; styles.css). */
  unpicked?: boolean;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  // 6h: the list is one Tab stop; ↑/↓ move between the providers.
  useRovingRows(list);
  return (
    <div
      ref={list}
      role="group"
      aria-label="Providers"
      data-unpicked={props.unpicked || undefined}
      className={cn(
        "flex flex-col p-1",
        props.framed !== false && "overflow-hidden rounded-xl border border-panel-edge bg-panel shadow-panel",
        props.className,
      )}
    >
      {/* The side columns' caption rule: on the rows' glyph column, a 20px line 16px under the row above and 4px over its
          first row (the first 8px under the list's top, so it lines up with the detail's 12px inset). */}
      {props.groups.map((g, i) => (
        <div key={g.id} role="group" aria-label={g.label} className={cn("flex flex-col", i === 0 ? "mt-2" : "mt-4")}>
          <SectionHeader inset as="h3" line="tight" className="mb-1">
            {g.label}
          </SectionHeader>
          {g.rows.map((r) => (
            <Row key={r.id} row={r} selected={r.id === props.selectedId} onSelect={() => props.onSelect(r.id)} />
          ))}
          {g.foldedLabel && (
            <ListRow size="lg" tone="quiet" leading={<Glyph icon={ChevronRight} size={14} />} title={g.foldedLabel} onClick={() => props.onExpand(true)} />
          )}
          {g.foldable && (
            <ListRow size="lg" tone="quiet" leading={<Glyph icon={ChevronDown} size={14} />} title="Show fewer" onClick={() => props.onExpand(false)} />
          )}
        </div>
      ))}
    </div>
  );
}

function Row({ row, selected, onSelect }: { row: ProviderRowView; selected: boolean; onSelect(): void }) {
  return (
    <ListRow
      size="lg"
      id={`row-provider-${row.id}`}
      selected={selected}
      onClick={onSelect}
      leading={<ProviderMark id={row.id} label={row.label} className="text-fg-2" />}
      title={row.label}
      description={`${row.status}${row.experimental ? " · Experimental" : ""}`}
      meta={<ToneDot tone={row.tone} />}
    />
  );
}
