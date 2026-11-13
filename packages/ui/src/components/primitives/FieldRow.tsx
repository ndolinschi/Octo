import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type FieldRowField = { id: string; label: string; control: ReactNode };

const COLS = { 1: "@md:grid-cols-1", 2: "@md:grid-cols-2", 3: "@md:grid-cols-3", 4: "@md:grid-cols-4" } as const;

/**
 * Decision 84 a: a row of fields on one grid. Labels share one line, controls share one line (same height, equal tops),
 * the hint sits on a third line under the whole row, so a hint never pushes a field or its neighbours. Each field is a
 * two-row subgrid cell; at narrow container width the fields stack, each still label over control. Needs an ancestor
 * with `@container` (the container query decides when to stack, not the window).
 */
export function FieldRow(props: { fields: readonly FieldRowField[]; hint?: ReactNode; status?: ReactNode; className?: string }) {
  const cols = Math.min(Math.max(props.fields.length, 1), 4) as keyof typeof COLS;
  return (
    <div data-field-row className={cn("grid grid-cols-1 gap-x-3 gap-y-1.5", COLS[cols], props.className)}>
      {props.fields.map((f) => (
        <div key={f.id} className="row-span-2 grid min-w-0 grid-rows-subgrid gap-y-1.5">
          <label htmlFor={f.id} className="self-end text-sm leading-5 text-fg-2">
            {f.label}
          </label>
          <div data-field-control className="flex min-w-0 items-center">
            {f.control}
          </div>
        </div>
      ))}
      {(props.hint || props.status) && (
        <div className="col-span-full flex flex-col gap-1 pt-1 text-xs text-fg-3">
          {props.hint && <p>{props.hint}</p>}
          {props.status}
        </div>
      )}
    </div>
  );
}
