import { formatDuration } from "./format";

/** A piece of the recap sentence: plain text, or a figure in `fg` that may link to its source (decision 26). */
export type RecapPart = { text: string } | { text: string; figure: true; link?: { project: string } | { model: string } | { usage: true } };

export type RecapInput = {
  period: "today" | "week";
  /** Requests sent in the period, per project (only projects with any). */
  projects: readonly { id: string; name: string; requests: number }[];
  /** The model with the largest share of the period's tokens, and that share (0–1). */
  topModel: { key: string; name: string; share: number } | null;
  /** Total time sub-agents ran in the period (ms). */
  agentMs: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Decision 26's recap — one paragraph built only from stored data, every clause omitted when it has nothing to say
 * (no zeros, no placeholders): "Today you sent **12 requests** across **3 projects**. Most went into **Atlas API**;
 * **Sonnet** carried **84%** of the tokens. Agents ran for **5h 47m**." Null when nothing happened.
 */
export function buildRecap(r: RecapInput): RecapPart[] | null {
  const lead = r.period === "today" ? "Today" : "This week";
  const total = r.projects.reduce((n, p) => n + p.requests, 0);
  const parts: RecapPart[] = [];
  const top = [...r.projects].sort((a, b) => b.requests - a.requests)[0];
  if (total > 0 && top) {
    if (r.projects.length === 1) {
      parts.push(
        { text: `${lead} you sent ` },
        { text: plural(total, "request", "requests"), figure: true },
        { text: " to " },
        { text: top.name, figure: true, link: { project: top.id } },
        { text: "." },
      );
    } else {
      parts.push(
        { text: `${lead} you sent ` },
        { text: plural(total, "request", "requests"), figure: true },
        { text: " across " },
        { text: plural(r.projects.length, "project", "projects"), figure: true },
        { text: ". Most went into " },
        { text: top.name, figure: true, link: { project: top.id } },
        { text: r.topModel ? "; " : "." },
      );
    }
  }
  if (r.topModel && r.topModel.share > 0) {
    const pct = `${Math.round(r.topModel.share * 100)}%`;
    const start = parts.length === 0 ? `${lead}, ` : parts.at(-1)?.text === "; " ? "" : " ";
    parts.push(
      { text: start },
      { text: r.topModel.name, figure: true, link: { model: r.topModel.key } },
      { text: " carried " },
      { text: pct, figure: true, link: { usage: true } },
      { text: " of the tokens." },
    );
  }
  if (r.agentMs >= 1000)
    parts.push({ text: parts.length ? " Agents ran for " : `${lead} agents ran for ` }, { text: formatDuration(r.agentMs), figure: true }, { text: "." });
  return parts.length ? parts.filter((p) => p.text !== "") : null;
}

/** The recap as plain text (its accessible name and the tests). */
export function recapText(parts: readonly RecapPart[]): string {
  return parts.map((p) => p.text).join("");
}

/** Clips an agent's run to the period [from, now] (ms); 0 when it ran outside it. */
export function runWithin(start: number, end: number, from: number): number {
  return Math.max(0, end - Math.max(start, from));
}
