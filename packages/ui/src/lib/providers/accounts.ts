import { splitAgentId, type Models, type Provider, type ProviderLimit } from "@octo/agent-client";
import { modelsPatchForSessionChoice, parseAcp, type AcpName } from "../models";
import { isReady } from "./providers";
import { providerStateText } from "./providersMore";

// Accounts of an agent (design 2026-11-26 sections 3, 7, 9): one agent, several logins. React-free.

/** The base agent id of a provider entry: the entry's own `base_id`, else the part of its id before the `@`. */
export const baseIdOf = (p: Pick<Provider, "id" | "base_id">): string => p.base_id ?? splitAgentId(p.id).base;

/** "15:00": a clock time in the person's zone, 24 hours. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "limit reached", with " until 15:00" when the reset time is known and still ahead; "" when no limit is reached. */
export function limitText(limit: ProviderLimit | undefined, now: number = Date.now()): string {
  if (!limit) return "";
  const reset = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
  return Number.isFinite(reset) && reset > now ? `limit reached until ${clock(reset)}` : "limit reached";
}

/** The agent entries of one base agent, in list order (the default account first, then the others as the harness lists them). */
export function accountsOf(providers: readonly Provider[], baseId: string): Provider[] {
  return providers.filter((p) => p.kind === "agent" && baseIdOf(p) === baseId);
}

/**
 * `providers` with the accounts of one agent side by side: each agent's siblings follow its first entry, the default account
 * first. With one account per agent the order is unchanged.
 */
export function groupSiblings(providers: readonly Provider[]): Provider[] {
  const out: Provider[] = [];
  const placed = new Set<string>();
  for (const p of providers) {
    if (p.kind !== "agent") {
      out.push(p);
      continue;
    }
    if (placed.has(p.id)) continue;
    const family = accountsOf(providers, baseIdOf(p));
    const defaults = family.filter((x) => x.id === baseIdOf(x));
    for (const x of [...defaults, ...family.filter((x) => x.id !== baseIdOf(x))]) {
      placed.add(x.id);
      out.push(x);
    }
  }
  return out;
}

/** The display name of an account: its own name, else the part of the label after the dot, else the label. */
export function accountName(p: Pick<Provider, "label" | "account">): string {
  if (p.account?.name) return p.account.name;
  const at = p.label.indexOf(" · ");
  return at > 0 ? p.label.slice(at + 3) : p.label;
}

/** The agent's own name without the account: "Claude Code" for "Claude Code · Work" (an entry with no account keeps its label). */
export function agentBaseLabel(p: Pick<Provider, "label" | "account">): string {
  if (!p.account) return p.label;
  const suffix = ` · ${accountName(p)}`;
  if (p.label.endsWith(suffix) && p.label.length > suffix.length) return p.label.slice(0, -suffix.length);
  const at = p.label.indexOf(" · ");
  return at > 0 ? p.label.slice(0, at) : p.label;
}

/** One account the limit banner offers instead of the one that ran out. */
export type AccountChoice = {
  /** The provider id (`claude-code@work`). */
  id: string;
  /** The setting a choice writes (`acp:claude-code@work`). */
  value: string;
  label: string;
  ready: boolean;
  /** "Ready", "Not logged in", … then the limit text when it is reached. */
  status: string;
};

/**
 * The other accounts of the agent that ran out (same base agent), the ones that can run first, then those that have hit
 * a limit themselves, then those that are not ready; each keeps the harness's order within its kind.
 */
export function siblingChoices(providers: readonly Provider[], failedId: string, now: number = Date.now()): AccountChoice[] {
  const failed = providers.find((p) => p.id === failedId);
  const base = failed ? baseIdOf(failed) : splitAgentId(failedId).base;
  const rank = (p: Provider) => (!isReady(p) ? 2 : p.limit ? 1 : 0);
  return accountsOf(providers, base)
    .filter((p) => p.id !== failedId)
    .map((p, order) => ({ p, order }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.order - b.order)
    .map(({ p }): AccountChoice => {
      const limit = limitText(p.limit, now);
      return { id: p.id, value: `acp:${p.id}`, label: p.label, ready: isReady(p), status: limit ? `${providerStateText(p)} · ${limit}` : providerStateText(p) };
    });
}

type Slots = Partial<Pick<Models, "orchestrator" | "fast" | "balanced" | "deep" | "side" | "auto_candidates">>;

/** `value` with its agent moved from `from` to `to` (the model part kept); undefined when it is not on `from`. */
function moved(value: string | undefined, from: string, to: string): string | undefined {
  const ref = value ? parseAcp(value) : null;
  if (ref?.id !== from) return undefined;
  return ref.model === null ? `acp:${to}` : `acp:${to}/${ref.model}`;
}

/** Whether any slot of the project's models (the auto candidates too) is on the agent `agentId`. */
export function namesAgent(agentId: string, models: Slots): boolean {
  const on = (v: string | undefined) => (v ? parseAcp(v)?.id === agentId : false);
  return (["orchestrator", "fast", "balanced", "deep", "side"] as const).some((slot) => on(models[slot])) || (models.auto_candidates ?? []).some(on);
}

/**
 * What the project's models become when the person answers a reached limit (design section 7). `choice` is a sibling
 * account (`acp:<base>@<other>` or the default `acp:<base>`, no model named): every slot on `failedAgentId` moves to it and
 * keeps its model part (`acp:claude-code@work/opus` becomes `acp:claude-code/opus`); a slot on any other agent is never
 * touched, so when no slot names the failed agent (the limit hit a sub-agent the orchestrator picked) the patch is empty.
 * Any other choice (a model, another agent) is the composer chip's own rule, `modelsPatchForSessionChoice`. Only changed
 * slots are returned.
 */
export function modelsPatchForAccountSwitch(choice: string, failedAgentId: string, models: Slots): Partial<Models> {
  const next = parseAcp(choice);
  const sibling = next !== null && next.model === null && next.id !== failedAgentId && splitAgentId(next.id).base === splitAgentId(failedAgentId).base;
  if (!next || !sibling) return modelsPatchForSessionChoice(choice, models);
  const patch: Partial<Models> = {};
  for (const slot of ["orchestrator", "fast", "balanced", "deep", "side"] as const) {
    const to = moved(models[slot], failedAgentId, next.id);
    if (to !== undefined) patch[slot] = to;
  }
  const candidates = models.auto_candidates;
  if (candidates?.some((c) => moved(c, failedAgentId, next.id) !== undefined)) {
    const mapped = candidates.map((c) => moved(c, failedAgentId, next.id) ?? c);
    patch.auto_candidates = mapped.filter((c, i) => mapped.indexOf(c) === i);
  }
  return patch;
}

/** What "Use another account" offers for a failed agent: nothing, a note that the project does not name it, or the accounts. */
export type SwitchOffer = { kind: "none" } | { kind: "unnamed" } | { kind: "choices"; choices: AccountChoice[]; anyReady: boolean };

/**
 * Whether the limit row offers "Use another account": only when the failed agent's base supports accounts and a sibling
 * exists; when the project's models do not name the failed account there is nothing to move (`unnamed`); otherwise the
 * siblings, and whether any can run now.
 */
export function accountSwitchOffer(providers: readonly Provider[], failedId: string, models: Slots, now: number = Date.now()): SwitchOffer {
  const failed = providers.find((p) => p.id === failedId);
  const base = failed ? baseIdOf(failed) : splitAgentId(failedId).base;
  if (providers.find((p) => p.id === base)?.accounts_support?.supported !== true) return { kind: "none" };
  const choices = siblingChoices(providers, failedId, now);
  if (choices.length === 0) return { kind: "none" };
  if (!namesAgent(failedId, models)) return { kind: "unnamed" };
  return { kind: "choices", choices, anyReady: choices.some((c) => c.ready) };
}

/** The name Octo suggests for an agent's existing login when a second account is added. */
export const DEFAULT_ACCOUNT_NAME = "Personal";

const MAX_NAME = 40;

/** Why `name` cannot name an account (empty, long, or the same as another account's), else null; `taken` are the other names. */
export function accountNameProblem(name: string, taken: readonly string[]): string | null {
  const n = name.trim();
  if (n === "") return "Give the account a name.";
  if (Array.from(n).length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
  if (taken.some((t) => t.trim().toLowerCase() === n.toLowerCase())) return "Another account already has that name.";
  return null;
}

/** The state of an account as one dim line: "Ready", "Not logged in", … then "limit reached until 15:00" when it is. */
export function accountStatus(p: Pick<Provider, "state" | "kind" | "login" | "limit">, now: number = Date.now()): string {
  const limit = limitText(p.limit, now);
  return limit ? `${providerStateText(p)} · ${limit}` : providerStateText(p);
}

/** Whether an entry is the agent's default account (its own login, the bare id). */
export const isDefaultAccount = (p: Pick<Provider, "id" | "base_id" | "account">): boolean => p.account?.default ?? p.id === baseIdOf(p);

/** The login methods an account offers: its own list, else one unnamed method when only a command is known, else none. */
export function loginChoices(p: Pick<Provider, "login_methods" | "login_command">): { id: string; label: string }[] {
  if (p.login_methods && p.login_methods.length > 0) return p.login_methods.map((m) => ({ id: m.id, label: m.label }));
  return p.login_command ? [{ id: "", label: "Log in" }] : [];
}

/**
 * The agent names that label `acp:` settings: the provider list's labels (an account reads "Claude Code · Work") win over
 * the config's, and an agent only the config knows keeps its own. An account no list names reads "<agent> · <account>"
 * (`agentLabelOf`).
 */
export function withProviderLabels(names: readonly AcpName[], providers: readonly Provider[]): AcpName[] {
  const fromProviders = providers.filter((p) => p.kind === "agent").map((p): AcpName => ({ id: p.id, label: p.label }));
  const known = new Set(fromProviders.map((n) => n.id));
  return [...fromProviders, ...names.filter((n) => !known.has(n.id))];
}
