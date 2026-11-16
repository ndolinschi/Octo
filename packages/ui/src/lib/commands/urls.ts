import { stripAnsi } from "./format";

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s"'<>)\]`]*)?/gi;

/** Extracts unique local dev-server URLs from command output in order of appearance, rewriting `0.0.0.0` to `localhost`. */
export function extractLocalUrls(output: string): string[] {
  if (!output) return [];
  const clean = stripAnsi(output);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of clean.matchAll(LOCAL_URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    try {
      const u = new URL(raw);
      if (u.hostname === "0.0.0.0") u.hostname = "localhost";
      const normalized = u.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    } catch {
      // Ignore malformed match
    }
  }
  return out;
}
