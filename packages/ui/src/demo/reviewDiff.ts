import type { DiffHunk, DiffLine } from "@octo/agent-client";

type Op = { type: "context" | "add" | "del"; text: string; old?: number; new?: number };

/** A line diff by longest common subsequence: enough for the demo's small files, and it makes `context` real. */
function ops(before: string[], after: string[], same: (a: string, b: string) => boolean): Op[] {
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => table[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i];
      if (row) row[j] = same(before[i] ?? "", after[j] ?? "") ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(before[i] ?? "", after[j] ?? "")) {
      out.push({ type: "context", text: after[j] ?? "", old: i + 1, new: j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || at(i, j + 1) >= at(i + 1, j))) {
      out.push({ type: "add", text: after[j] ?? "", new: j + 1 });
      j++;
    } else {
      out.push({ type: "del", text: before[i] ?? "", old: i + 1 });
      i++;
    }
  }
  return out;
}

const split = (text: string | null): string[] => (text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** Hunks of a file change with `context` lines around each change (changes closer than twice that merge). */
export function lineDiff(before: string | null, after: string | null, context: number, ignoreWhitespace: boolean): DiffHunk[] {
  const same = ignoreWhitespace ? (a: string, b: string) => a.trim() === b.trim() : (a: string, b: string) => a === b;
  const all = ops(split(before), split(after), same);
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((o, i) => {
    if (o.type === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
  });
  const hunks: DiffHunk[] = [];
  let current: Op[] | null = null;
  all.forEach((o, i) => {
    if (!keep[i]) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      hunks.push({ old_start: 0, old_lines: 0, new_start: 0, new_lines: 0, header: "", lines: [] });
    }
    current.push(o);
    const h = hunks[hunks.length - 1];
    if (h) h.lines = current.map(toLine);
  });
  for (const h of hunks) {
    const firstOld = h.lines.find((l) => l.old !== undefined)?.old;
    const firstNew = h.lines.find((l) => l.new !== undefined)?.new;
    h.old_lines = h.lines.filter((l) => l.type !== "add").length;
    h.new_lines = h.lines.filter((l) => l.type !== "del").length;
    h.old_start = firstOld ?? 0;
    h.new_start = firstNew ?? 0;
    h.header = `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`;
  }
  return hunks;
}

function toLine(o: Op): DiffLine {
  return { type: o.type, text: o.text, ...(o.old !== undefined ? { old: o.old } : {}), ...(o.new !== undefined ? { new: o.new } : {}) };
}

export function countLines(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.type === "add") added++;
      else if (l.type === "del") removed++;
    }
  return { added, removed };
}

/** 1-based line number of the first line of `text` that contains `needle`; 1 when none does. */
export function lineOf(text: string, needle: string): number {
  const at = text.split("\n").findIndex((l) => l.includes(needle));
  return at < 0 ? 1 : at + 1;
}
