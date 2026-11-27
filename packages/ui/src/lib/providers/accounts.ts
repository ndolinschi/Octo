import { splitAgentId, type Models, type Provider, type ProviderLimit } from "@octo/agent-client";
import { modelsPatchForSessionChoice, parseAcp, type AcpName } from "../models";
import { isReady } from "./providers";
import { providerStateText } from "./providersMore";

/**
 * Agent accounts (T3 Code's "instances" in Octo's terms): an agent whose entry has `account_env` takes more logins, each
 * kept in its own folder and listed as an agent of its own, `<agent>@<account>`. These helpers read the shared list.
 */

/** The accounts of `agentId`, in the list's order. */
export function accountsOf(providers: readonly Provider[], agentId: string): Provider[] {
  return providers.filter((p) => p.account_of === agentId);
}

/** The agent an account belongs to; undefined for anything else. */
export function accountBase(providers: readonly Provider[], p: Pick<Provider, "account_of">): Provider | undefined {
  return p.account_of ? providers.find((x) => x.id === p.account_of) : undefined;
}

/** Whether the detail of `p` offers "Add account". */
export const takesAccounts = (p: Pick<Provider, "kind" | "account_env" | "account_of">): boolean => p.kind === "agent" && !!p.account_env && !p.account_of;

/** The id the harness makes from a name: lower-case letters and digits, other runs one hyphen, at most 32. */
export function accountSlug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return s || "account";
}

/**
 * The folder offered for a new account: the agent's default folder with the name after a hyphen (`~/.claude` and
 * "Work" give `~/.claude-work`); `~/.<agent>-<name>` when the manifest names no default.
 */
export function suggestedAccountDir(agent: Pick<Provider, "id" | "account_default">, label: string): string {
  const slug = accountSlug(label.trim() || "account");
  const base = (agent.account_default ?? "").replace(/\/+$/, "") || `~/.${agent.id}`;
  return `${base}-${slug}`;
}

/** The agent an entry runs: the agent of an account (`account_of`), else the part of its id before the `@`. */
export const baseIdOf = (p: Pick<Provider, "id" | "account_of">): string => p.account_of ?? splitAgentId(p.id).base;

/** The agent's own entry first, then its accounts in list order. */
export function familyOf(providers: readonly Provider[], baseId: string): Provider[] {
  const own = providers.filter((p) => p.kind === "agent" && p.id === baseId);
  return [...own, ...providers.filter((p) => p.kind === "agent" && p.account_of === baseId)];
}

/** The name the agent's own login reads as in its Accounts list: the name the user gave it, else "Default". */
export const defaultAccountName = (agent: Pick<Provider, "account_default_label">): string => agent.account_default_label ?? "Default";

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

/** The state of an account as one dim line: "Ready", "Not logged in", … then "limit reached until 15:00" when it is. */
export function accountStatus(p: Pick<Provider, "state" | "kind" | "login" | "limit">, now: number = Date.now()): string {
  const limit = limitText(p.limit, now);
  return limit ? `${providerStateText(p)} · ${limit}` : providerStateText(p);
}

/**
 * `providers` with the accounts of one agent right after the agent's own entry (the harness lists them so; this keeps it
 * for a list that does not). With no accounts the order is unchanged.
 */
export function groupSiblings(providers: readonly Provider[]): Provider[] {
  if (!providers.some((p) => p.account_of)) return [...providers];
  const out: Provider[] = [];
  const placed = new Set<string>();
  for (const p of providers) {
    if (placed.has(p.id)) continue;
    const family = p.kind === "agent" ? familyOf(providers, baseIdOf(p)) : [p];
    for (const x of family.length > 0 ? family : [p]) {
      if (placed.has(x.id)) continue;
      placed.add(x.id);
      out.push(x);
    }
  }
  return out;
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
 * The other logins of the agent that ran out (its own entry and its accounts), the ones that can run first, then those
 * that have hit a limit themselves, then those that are not ready; each keeps the harness's order within its kind.
 */
export function siblingChoices(providers: readonly Provider[], failedId: string, now: number = Date.now()): AccountChoice[] {
  const failed = providers.find((p) => p.id === failedId);
  const base = failed ? baseIdOf(failed) : splitAgentId(failedId).base;
  const rank = (p: Provider) => (!isReady(p) ? 2 : p.limit ? 1 : 0);
  return familyOf(providers, base)
    .filter((p) => p.id !== failedId)
    .map((p, order) => ({ p, order }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.order - b.order)
    .map(({ p }): AccountChoice => ({ id: p.id, value: `acp:${p.id}`, label: p.label, ready: isReady(p), status: accountStatus(p, now) }));
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
 * What the project's models become when the person answers a reached limit. `choice` is a sibling login
 * (`acp:<agent>@<other>` or the agent's own `acp:<agent>`, no model named): every slot on `failedAgentId` moves to it and
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
 * Whether the limit row offers "Use another account": only when the failed agent takes accounts (`account_env`) and
 * another login exists; when the project's models do not name the failed one there is nothing to move (`unnamed`);
 * otherwise the other logins, and whether any can run now.
 */
export function accountSwitchOffer(providers: readonly Provider[], failedId: string, models: Slots, now: number = Date.now()): SwitchOffer {
  const failed = providers.find((p) => p.id === failedId);
  const base = failed ? baseIdOf(failed) : splitAgentId(failedId).base;
  if (!providers.find((p) => p.id === base)?.account_env) return { kind: "none" };
  const choices = siblingChoices(providers, failedId, now);
  if (choices.length === 0) return { kind: "none" };
  if (!namesAgent(failedId, models)) return { kind: "unnamed" };
  return { kind: "choices", choices, anyReady: choices.some((c) => c.ready) };
}

/** The login methods an entry offers: its own list, else one unnamed method when only a command is known, else none. */
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
