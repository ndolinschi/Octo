import type { TierPolicy } from "@octo/agent-client";
import { modelName, type AcpName } from "./models";

/** The model helpers the first paint does not need (budgets, tier policies, route lines, truncation): a separate module keeps `models.ts` small. */

/**
 * Shortens `text` to `max` characters in the middle while keeping at least `keepTail` characters of its end — the part
 * that tells two similar model ids apart ("deepseek-v4.1-fl…flash-0905").
 */
export function middleEllipsis(text: string, max: number, keepTail = 0): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const tail = Math.min(max - 2, Math.max(keepTail, Math.floor((max - 1) / 2)));
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The shortest end of each name that no other name in `names` shares (the whole name when one ends another). */
export function distinctTails(names: readonly string[]): number[] {
  return names.map((n, i) => {
    let len = 1;
    for (const [j, other] of names.entries()) {
      if (j === i || other === n) continue;
      let common = 0;
      while (common < n.length && common < other.length && n[n.length - 1 - common] === other[other.length - 1 - common]) common += 1;
      len = Math.max(len, Math.min(n.length, common + 1));
    }
    return len;
  });
}

/** Middle truncation for a list shown together (Usage rows): each keeps the tail that tells it apart from the others. */
export function truncateDistinct(names: readonly string[], max: number): string[] {
  const tails = distinctTails(names);
  return names.map((n, i) => middleEllipsis(n, max, tails[i] ?? 0));
}

export const TIER_POLICIES: readonly { value: TierPolicy; label: string; detail: string }[] = [
  { value: "auto", label: "Auto", detail: "Octo picks a cheaper or stronger model for each task" },
  { value: "ceiling", label: "Ceiling", detail: "Never stronger than the tier you chose; may go cheaper" },
  { value: "fixed", label: "Fixed", detail: "Always the tier you chose: steady quality and cost" },
];

export function policyLabel(policy: TierPolicy | undefined): string {
  return TIER_POLICIES.find((p) => p.value === (policy ?? "auto"))?.label ?? "Auto";
}

/** Decision 37: "$1.20 / $5.00", amber from 80%, red at 100% ("Project budget reached"). Null without a budget. */
export function budgetState(
  spent: number | null | undefined,
  budget: number | null | undefined,
): { text: string; tone: "fg-3" | "warn" | "err"; reached: boolean; share: number } | null {
  if (typeof budget !== "number" || !(budget > 0)) return null;
  const used = typeof spent === "number" && spent > 0 ? spent : 0;
  const share = used / budget;
  return { text: `${usd(used)} / ${usd(budget)}`, tone: share >= 1 ? "err" : share >= 0.8 ? "warn" : "fg-3", reached: share >= 1, share };
}

function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** Parses the Budget field: a positive amount in USD ("12", "$12.50"), "" for none; NaN when it is not a number. */
export function parseBudget(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : Number.NaN;
}

/**
 * The model ids among settings values (a project's `models`, the bridge's `default_models`), each once, in order: strings
 * only — `auto_candidates` is a list and `tier_policy` a policy word, neither is a model.
 */
export function modelIds(...values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id && !TIER_POLICIES.some((p) => p.value === id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A delegation's route decision as one quiet line (live test): "Chosen automatically: medium task; Claude Code on your
 * subscription was able to do it". Null for an agent spawned at an explicit tier (all route fields null).
 */
export function routeLine(
  a: { route_choice?: string | null; route_band?: string | null; route_reason?: string | null },
  acp: readonly AcpName[] = [],
): string | null {
  if (!a.route_choice) return null;
  const tiers: Record<string, string> = { fast: "the fast tier", balanced: "the balanced tier", deep: "the deep tier" };
  const choice = tiers[a.route_choice] ?? modelName(a.route_choice, acp);
  const reason = a.route_reason?.trim();
  // UX-14: a reason that already names the band ("Medium task; …") is not preceded by it again.
  const band = a.route_band && !reason?.toLowerCase().startsWith(`${a.route_band.toLowerCase()} task`) ? `${a.route_band} task; ` : "";
  return `Chosen automatically: ${band}${reason ?? choice}${reason && !reason.toLowerCase().includes(choice.toLowerCase()) ? ` (${choice})` : ""}`;
}
