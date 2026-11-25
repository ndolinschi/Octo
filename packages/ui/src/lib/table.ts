/**
 * Decision 44 — tables and structured results, the pure part: tool output that is tabular (CSV, a JSON array of flat
 * objects) or key–value (a flat JSON object of up to 8 pairs), numeric-column detection, and Markdown / CSV export.
 */

/** Tool results shown as a table hold at most this many rows (the rest is in the raw text). */
export const MAX_ROWS = 200;
/** Above this many rows a table folds behind "Show all N rows". */
export const FOLD_ROWS = 12;
/** A key–value result of at most this many pairs is a definition list. */
export const MAX_PAIRS = 8;

import { NUMERIC_CELL } from "./numericCell";

export { NUMERIC_CELL };

export type Table = { head: string[]; rows: string[][]; truncated: number };
export type Structured = { kind: "table"; table: Table } | { kind: "pairs"; pairs: [string, string][] };

/** Columns whose body cells are all numbers (and at least one has a digit): right-aligned with tabular figures. */
export function numericColumns(rows: readonly (readonly string[])[], width: number): boolean[] {
  return Array.from({ length: width }, (_, col) => {
    const cells = rows.map((r) => (r[col] ?? "").trim());
    return cells.some((c) => /\d/.test(c)) && cells.every((c) => NUMERIC_CELL.test(c));
  });
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const scalar = (v: unknown): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v);
const show = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

function capped(head: string[], rows: string[][]): Table {
  return { head, rows: rows.slice(0, MAX_ROWS), truncated: Math.max(0, rows.length - MAX_ROWS) };
}

/**
 * What a tool result is, when it is structured: a JSON array of flat objects (≥ 2 keys) or a CSV with a header and
 * ≥ 1 row of the same width (≥ 2 columns) is a table; a flat JSON object of 1–8 keys is pairs. Null otherwise.
 */
export function structured(text: string): Structured | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("[") || t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
    if (Array.isArray(v)) {
      const items: unknown[] = v;
      if (items.length === 0 || !items.every((o) => typeof o === "object" && o !== null && !Array.isArray(o) && Object.values(o).every(scalar))) return null;
      // Checked above: every item is a flat object of scalars.
      const objects = items as Record<string, unknown>[];
      const head = [...new Set(objects.flatMap((o) => Object.keys(o)))];
      if (head.length < 2) return null;
      return {
        kind: "table",
        table: capped(
          head,
          objects.map((o) => head.map((k) => show(o[k]))),
        ),
      };
    }
    if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v as Record<string, unknown>);
      const flat = entries.flatMap(([k, x]) => (scalar(x) ? [[k, show(x)] as [string, string]] : []));
      if (entries.length === 0 || entries.length > MAX_PAIRS || flat.length !== entries.length) return null;
      return { kind: "pairs", pairs: flat };
    }
    return null;
  }
  // CSV: one comma at least on every line, the same width everywhere, a header that is not all numbers.
  if (!t.includes(",") || !t.includes("\n")) return null;
  const rows = parseCsv(t);
  const [head, ...body] = rows;
  if (!head || head.length < 2 || body.length === 0 || !rows.every((r) => r.length === head.length)) return null;
  if (head.every((h) => NUMERIC_CELL.test(h.trim()))) return null;
  return {
    kind: "table",
    table: capped(
      head.map((h) => h.trim()),
      body.map((r) => r.map((c) => c.trim())),
    ),
  };
}

const mdCell = (c: string) => c.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A GitHub-flavoured Markdown table (numeric columns right-aligned). */
export function toMarkdown(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const num = numericColumns(rows, head.length);
  const line = (cells: readonly string[]) => `| ${head.map((_, i) => mdCell(cells[i] ?? "")).join(" | ")} |`;
  const rule = `| ${head.map((_, i) => (num[i] ? "---:" : "---")).join(" | ")} |`;
  return [line(head), rule, ...rows.map(line)].join("\n");
}

const csvCell = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

export function toCsv(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [head, ...rows].map((r) => head.map((_, i) => csvCell(r[i] ?? "")).join(",")).join("\n");
}
