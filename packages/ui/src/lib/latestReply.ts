import type { Message } from "@octo/agent-client";
import { excerpt } from "./format";

/**
 * The first prose line of the orchestrator's latest reply, as plain text (Home's project list, decision 23): headings,
 * tables, code blocks, rules and quotes are skipped; list items count without their marker. Null when the latest reply
 * has no prose line (nothing is shown then, rather than a heading fragment).
 * Kept out of `lib/transcript.ts` so the entry bundle does not carry it (only lazy `state/requests` uses it).
 */
export function latestReply(messages: readonly Message[]): { text: string; at: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (!text.trim()) continue;
    const line = firstProseLine(text);
    return line ? { text: line, at: m.created_at } : null;
  }
  return null;
}

function firstProseLine(markdown: string): string | null {
  let fence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line) continue;
    // Headings, table rows and separators, rules, quotes, HTML: not prose.
    if (/^(#{1,6}\s|\||[-*_]{3,}$|>|<)/.test(line)) continue;
    const prose = excerpt(line.replace(/^([-*+]|\d+[.)])\s+/, ""), 160);
    if (prose && /[\p{L}\p{N}]/u.test(prose)) return prose;
  }
  return null;
}
