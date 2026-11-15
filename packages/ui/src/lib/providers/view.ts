import type { Provider, ProviderModel, ProviderState } from "@octo/agent-client";
import { timeAgo } from "../format";
import { stateText } from "./providersMore";
import { plainReason } from "./reasons";

// Decision 89: Settings → Providers is a list and a detail. Everything the page decides is here, React-free.

export type ProviderGroupId = "connected" | "attention" | "not_set_up";
export type Tone = "ok" | "warn" | "err" | "muted";

const GROUP_LABEL: Record<ProviderGroupId, string> = { connected: "Connected", attention: "Needs attention", not_set_up: "Not set up" };
const GROUP_ORDER: readonly ProviderGroupId[] = ["connected", "attention", "not_set_up"];

/** Ready is connected; a login that lapsed or a provider that stopped working needs attention; the rest was never set up. */
export function groupOf(p: Pick<Provider, "state">): ProviderGroupId {
  switch (p.state) {
    case "ready":
      return "connected";
    case "not_logged_in":
    case "error":
      return "attention";
    case "not_installed":
    case "not_connected":
    case "not_supported":
      return "not_set_up";
  }
}

const TONE: Record<ProviderState, Tone> = {
  ready: "ok",
  not_logged_in: "warn",
  error: "err",
  not_installed: "muted",
  not_connected: "muted",
  not_supported: "muted",
};
export const stateTone = (p: Pick<Provider, "state">): Tone => TONE[p.state];

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The one dim line under a row's name: "Ready · 16 models", "Not logged in", "Not installed", "Not set up". */
export function rowStatus(p: Pick<Provider, "state" | "models">): string {
  if (p.state === "ready" && p.models.length > 0) return `Ready · ${count(p.models.length, "model")}`;
  return stateText(p.state);
}

export type ProviderRowView = { id: string; label: string; status: string; tone: Tone; experimental: boolean };
export type ProviderGroupView = {
  id: ProviderGroupId;
  label: string;
  /** The rows to show: empty while the group is folded into its one summary row. */
  rows: ProviderRowView[];
  /** "6 more agents can be added" while folded, else null. */
  foldedLabel: string | null;
  /** The group can be folded again (it was opened by the summary row). */
  foldable: boolean;
};

const rowOf = (p: Provider): ProviderRowView => ({
  id: p.id,
  label: p.label,
  status: rowStatus(p),
  tone: stateTone(p),
  experimental: p.experimental === true,
});

function foldedLabel(members: readonly Provider[]): string {
  const noun = members.every((m) => m.kind === "agent") ? "agent" : "provider";
  return `${members.length} more ${noun}${members.length === 1 ? "" : "s"} can be added`;
}

/**
 * The list's groups in their fixed order, empty ones left out. "Not set up" is folded to one summary row when something is
 * connected, unless it was opened (`expanded`) or holds the selected provider.
 */
export function providerGroups(providers: readonly Provider[], opts: { expanded?: boolean; selectedId?: string | undefined } = {}): ProviderGroupView[] {
  const anyConnected = providers.some((p) => groupOf(p) === "connected");
  return GROUP_ORDER.flatMap((id): ProviderGroupView[] => {
    const members = providers.filter((p) => groupOf(p) === id);
    if (members.length === 0) return [];
    const fold = id === "not_set_up" && anyConnected && !opts.expanded && !members.some((m) => m.id === opts.selectedId);
    const foldable = id === "not_set_up" && anyConnected && !fold;
    return [{ id, label: GROUP_LABEL[id], rows: fold ? [] : members.map(rowOf), foldedLabel: fold ? foldedLabel(members) : null, foldable }];
  });
}

/** The provider shown in the detail when none was picked: the first row of the first group. */
export function defaultProviderId(providers: readonly Provider[]): string | undefined {
  for (const g of GROUP_ORDER) {
    const first = providers.find((p) => groupOf(p) === g);
    if (first) return first.id;
  }
  return undefined;
}

/** The one filled button of a detail's title row (decision 89 d); null when there is nothing to do. */
export type PrimaryAction = "Connect" | "Check again";
export function primaryAction(p: Pick<Provider, "state" | "kind">): PrimaryAction | null {
  switch (p.state) {
    case "ready":
    case "not_supported":
      return null;
    case "not_connected":
      return "Connect";
    case "not_logged_in":
    case "not_installed":
    case "error":
      // An agent's steps are in the pane itself (commands to copy); what is left to press is looking again.
      return p.kind === "agent" ? "Check again" : "Connect";
  }
}

/** One line: what using this provider costs. */
export function billingLine(p: Pick<Provider, "kind" | "flat_rate">): string {
  if (p.flat_rate) return "Included in your subscription: no charge per token.";
  return p.kind === "router" ? "Per token, billed through your Octo router key." : "Per token, billed to your API key.";
}

/** Why it is not ready, in plain words and without repeating the state; "" when the provider is ready. */
export function reasonLine(p: Pick<Provider, "state" | "kind" | "reason" | "problem">): string {
  switch (p.state) {
    case "ready":
      return "";
    case "not_supported": {
      const r = plainReason(p).trim();
      return r || "Octo can't use this agent.";
    }
    case "not_installed":
      return "This agent is not on this computer yet. Install it and log in once in a terminal, then press Check again.";
    case "not_logged_in":
      return "Installed, but not logged in. Log in once in a terminal, then press Check again.";
    case "not_connected":
      return p.kind === "api" ? "Add an API key to bill per token through your own account." : "Turn the Octo router on and add its provider key.";
    case "error": {
      const r = plainReason(p).trim();
      return r ? `Not working: ${r.replace(/\.$/, "")}.` : "Not working. Check again, or copy the diagnostic report from Privacy and data.";
    }
  }
}

/** "16 models" with when they were last looked up: "16 models · updated 2h ago". */
export function modelsSummary(p: Pick<Provider, "models" | "models_refreshed_at">, now: number): string {
  const n = p.models.length === 0 ? "No models listed" : count(p.models.length, "model");
  return p.models_refreshed_at ? `${n} · updated ${timeAgo(p.models_refreshed_at, now)}` : n;
}

export const MODELS_FOLDED = 6;

/** The models shown: all of them when `open`, else the first six; `hidden` is what "Show all" would add. */
export function foldModels(models: readonly ProviderModel[], open: boolean, limit = MODELS_FOLDED): { shown: ProviderModel[]; hidden: number } {
  if (open || models.length <= limit) return { shown: [...models], hidden: 0 };
  return { shown: models.slice(0, limit), hidden: models.length - limit };
}
