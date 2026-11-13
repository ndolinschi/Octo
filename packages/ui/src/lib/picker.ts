import type { ReactNode } from "react";

/** One row of a quick picker (`primitives/Picker`): what it shows and what choosing it does. */
export type PickerRow = {
  id: string;
  label: string;
  /** Muted text after the name (provider, "subscription", a path). */
  detail?: string;
  /** Right-aligned muted text (a shortcut, "logged out"). */
  hint?: string;
  /** The 16px leading slot (a glyph or a state ring). */
  lead?: ReactNode;
  title?: string;
  disabled?: boolean;
  /** A second, dim line under the name (a folder's path relative to home); the row is two lines tall. */
  sub?: string;
  /** The row does its work and the picker stays open (it closes itself when the work is done). */
  keepOpen?: boolean;
  /** The row is waiting for something (a spinner replaces its glyph). */
  busy?: boolean;
  /** The current value of a choice. */
  checked?: boolean;
  /** `detail` is a path: cut from the left so its end (nearest the file) stays visible. */
  pathDetail?: boolean;
  /** After the hint: a chevron, row actions (kept out of the tab order). */
  trailing?: ReactNode;
  /** Replaces the row's text (a field inside the list); the row keeps its size and fill. */
  content?: ReactNode;
  /** The name is dim (a provider that is not connected). */
  quiet?: boolean;
  run(): void;
};

export type PickerSection = { title: string; rows: PickerRow[] };

/** The next active index when moving by `delta` through `count` enabled rows from `at` (−1: none yet), wrapping. */
export function pickerIndex(at: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0) return delta > 0 ? 0 : count - 1;
  return (at + delta + count) % count;
}

/** Whether a row matches a typed query: every word appears in its label or detail (case-insensitive). */
export function rowMatches(row: Pick<PickerRow, "label" | "detail">, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${row.label} ${row.detail ?? ""}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Sections narrowed to the rows matching `query` (empty sections dropped). */
export function filterSections(sections: readonly PickerSection[], query: string): PickerSection[] {
  return sections.map((s) => ({ ...s, rows: s.rows.filter((r) => rowMatches(r, query)) })).filter((s) => s.rows.length > 0);
}
