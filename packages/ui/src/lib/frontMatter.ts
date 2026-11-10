/**
 * A Markdown file's leading YAML front matter (`---` … `---` on the first lines): split off so the preview does not
 * render it as a rule and a heading. `fields` are the top-level `key: value` lines (others are kept as raw lines).
 */
export function splitFrontMatter(text: string): { fields: [string, string][]; body: string } | null {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields: [string, string][] = [];
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) fields.push([kv[1], (kv[2] ?? "").replace(/^(["'])(.*)\1$/, "$2")]);
    else if (line.trim()) {
      const last = fields[fields.length - 1];
      if (last) last[1] = `${last[1]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(m[0].length) };
}
