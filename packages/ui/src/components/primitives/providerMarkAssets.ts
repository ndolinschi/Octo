import { markKeyOf } from "../../lib/providers/markKey";

/**
 * The vendor marks as asset URLs, the id table and our neutral fallback shapes. This module is its own chunk (it imports no
 * React, so loading it needs no preload step), fetched by `ProviderMark` after first paint: none of it weighs on the entry
 * bundle. `?no-inline` keeps every SVG a real file (Vite would otherwise embed the small ones as data URIs in this chunk).
 */
const FILES = import.meta.glob<string>("../../assets/providers/*.svg", { eager: true, query: "?no-inline", import: "default" });

const BY_KEY = new Map<string, string>();
for (const [path, url] of Object.entries(FILES)) {
  const key = /([^/]+)\.svg$/.exec(path)?.[1];
  if (key) BY_KEY.set(key, url);
}

/** Our own neutral shapes: the router's mark, and the fallback of an id with no vendor mark (its shape comes from its letters, so the same id always looks the same). */
const OUTLINES: readonly string[] = [
  "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13Z",
  "M4 1.5h8a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5Z",
  "M8 1l6.5 7L8 15L1.5 8Z",
  "M8 1.2l5.9 3.4v6.8L8 14.8l-5.9-3.4V4.6Z",
  "M8 1.8l6.4 11.4H1.6Z",
];
const DIAMOND = 2;
const TRIANGLE = 4;

/** What to draw for an id: the vendor's SVG file, or the neutral shape (outline path, baseline of the initial, the initial). */
export function markOf(id: string, label: string): { url: string } | { d: string; y: number; initial: string } {
  const key = markKeyOf(id);
  const url = key === null ? undefined : BY_KEY.get(key);
  if (url) return { url };
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
  const shape = id === "router" ? DIAMOND : h % OUTLINES.length;
  return {
    d: OUTLINES[shape] ?? "",
    y: shape === TRIANGLE ? 11.6 : 10.6,
    initial: (label.trim().charAt(0) || id.charAt(0) || "?").toUpperCase(),
  };
}
