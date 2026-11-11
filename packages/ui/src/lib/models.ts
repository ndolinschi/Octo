import type { AcpOrchestratorChoice, TierPolicy } from "@octo/agent-client";

/** What the UI needs of an ACP agent to name it: its id and label (from `config.acp_orchestrators` or the plugins list). */
export type AcpName = Pick<AcpOrchestratorChoice, "id" | "label">;

/** `acp:<id>` or `acp:<id>/<model>` split into its parts; null for a Messages API model id. */
export function parseAcp(value: string): { id: string; model: string | null } | null {
  if (!value.startsWith("acp:")) return null;
  const rest = value.slice(4);
  const slash = rest.indexOf("/");
  if (slash < 0) return rest ? { id: rest, model: null } : null;
  const id = rest.slice(0, slash);
  const model = rest.slice(slash + 1);
  return id ? { id, model: model || null } : null;
}

/** "claude-sonnet-5-5-20261001" → "Sonnet 5.5"; ids that do not follow that shape are shown whole (never guessed at). */
export function claudeLabel(model: string): string {
  const id = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const [, family, major, minor] = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id) ?? [];
  if (!model.startsWith("claude-") || family === undefined || major === undefined) return model;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

/**
 * Decision 48: a model id as shown — a Claude id as its family and version, any other id without its vendor prefix
 * ("deepseek/deepseek-v4.1-flash" → "deepseek-v4.1-flash"); places with little room middle-truncate it (`middleEllipsis`).
 */
export function displayId(id: string): string {
  const label = claudeLabel(id);
  if (label !== id) return label;
  const slash = id.lastIndexOf("/");
  return slash >= 0 && slash < id.length - 1 ? id.slice(slash + 1) : id;
}

/**
 * A model setting as people read it: a Claude id as its family and version, an `acp:` value as the agent's label and
 * its model ("Claude Code · Opus 5.5", never the raw string), anything else whole.
 */
export function modelName(value: string, acp: readonly AcpName[] = []): string {
  const ref = parseAcp(value);
  if (!ref) return displayId(value);
  const label = acp.find((a) => a.id === ref.id)?.label ?? ref.id;
  return ref.model ? `${label} · ${displayId(ref.model)}` : label;
}

/** The model that answered (decision 37): `served_model` when a router reported one, and the requested one when it differs. */
export function servedModel(agent: { model: string; served_model?: string | null }, acp: readonly AcpName[] = []): { name: string; asked: string | null } {
  const asked = modelName(agent.model, acp);
  const served = agent.served_model?.trim();
  if (!served) return { name: asked, asked: null };
  const name = modelName(served, acp);
  return { name, asked: name === asked || served === agent.model ? null : asked };
}

/** Details' long form: "deepseek-v4.1-flash · asked for Sonnet 5.5", or the name alone. */
export function servedText(agent: { model: string; served_model?: string | null }, acp: readonly AcpName[] = []): string {
  const s = servedModel(agent, acp);
  return s.asked ? `${s.name} · asked for ${s.asked}` : s.name;
}

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
  { value: "auto", label: "Auto", detail: "The router may go lower or higher" },
  { value: "ceiling", label: "Ceiling", detail: "Never above the chosen tier" },
  { value: "fixed", label: "Fixed", detail: "Always the chosen tier" },
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
  const band = a.route_band ? `${a.route_band} task; ` : "";
  const reason = a.route_reason?.trim();
  return `Chosen automatically: ${band}${reason ?? choice}${reason && !reason.toLowerCase().includes(choice.toLowerCase()) ? ` (${choice})` : ""}`;
}
