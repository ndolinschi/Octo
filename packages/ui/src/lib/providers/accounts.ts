import type { Provider } from "@octo/agent-client";

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
