import type { RefObject } from "react";
import { filterSections, type PickerRow } from "../../lib/picker";
import { Picker } from "../primitives/Picker";

/** Decision 25's overflow list: every tab of a scrolling strip, searchable (its own chunk, like the "+" picker). */
export function AllTabsPicker(props: { anchor: RefObject<HTMLElement | null>; rows: PickerRow[]; onClose(): void }) {
  return (
    <Picker
      anchor={props.anchor}
      label="All tabs"
      placeholder="Search open tabs"
      align="end"
      onClose={props.onClose}
      sections={(q) => filterSections([{ title: `${props.rows.length} tabs`, rows: props.rows }], q)}
    />
  );
}
