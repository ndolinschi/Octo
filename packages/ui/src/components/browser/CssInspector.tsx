import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { CssEdit, PickedElement } from "../../lib/browser/designNotes";
import { IconButton } from "../primitives/IconButton";
import { SearchField } from "../primitives/SearchField";
import { TextField } from "../primitives/TextField";

const DEFAULT_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "gap",
  "border-radius",
  "border",
  "display",
  "align-items",
  "justify-content",
  "width",
  "height",
  "opacity",
];

/**
 * Live CSS property editor inside `NoteCard` for a single picked element.
 * Changes preview immediately in the iframe via `onApplyCss` and record `CssEdit` entries on the note.
 */
export function CssInspector(props: {
  element: PickedElement;
  edits: readonly CssEdit[];
  onChangeProp(property: string, before: string, after: string | null): void;
}) {
  const [filter, setFilter] = useState("");
  const baseStyles = props.element.editableStyles ?? {};
  const keys = Object.keys(baseStyles).length ? Object.keys(baseStyles) : DEFAULT_PROPS;
  const q = filter.trim().toLowerCase();
  const visible = q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys;

  const editMap = new Map(props.edits.map((e) => [e.property, e]));

  return (
    <div data-css-inspector className="flex flex-col gap-2 border-t border-line pt-2">
      <SearchField size="sm" value={filter} onChange={setFilter} label="Filter CSS properties" placeholder="Filter CSS properties…" />
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
        {visible.map((prop) => {
          const before = editMap.get(prop)?.before ?? baseStyles[prop] ?? "";
          const current = editMap.get(prop)?.after ?? before;
          const modified = editMap.has(prop);
          return (
            <div key={prop} className="flex items-center gap-2">
              <span
                title={prop}
                className={modified ? "w-28 shrink-0 truncate font-mono text-xs font-medium text-fg" : "w-28 shrink-0 truncate font-mono text-xs text-fg-2"}
              >
                {prop}
              </span>
              <TextField
                size="xs"
                aria-label={`CSS ${prop}`}
                value={current}
                onChange={(e) => props.onChangeProp(prop, before, e.target.value)}
                className="min-w-0 flex-1 font-mono text-xs"
              />
              {modified ? (
                <IconButton icon={RotateCcw} label={`Reset ${prop}`} size="xs" onClick={() => props.onChangeProp(prop, before, null)} />
              ) : (
                <span aria-hidden className="size-6 shrink-0" />
              )}
            </div>
          );
        })}
        {visible.length === 0 && <p className="py-2 text-center text-xs text-fg-3">No matching CSS properties</p>}
      </div>
    </div>
  );
}
