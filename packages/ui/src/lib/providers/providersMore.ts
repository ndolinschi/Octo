import type { Provider, ProvidersResponse, ProviderState } from "@octo/agent-client";
import { isReady } from "./providers";

/** The provider words and lookups the connect screens and lists use; `providers.ts` keeps only what the first paint needs. */

/** Ids of the two providers that are not agents (`GET /v1/providers` uses the same ones). */
export const API_PROVIDER = "api";
export const ROUTER_PROVIDER = "router";

const STATE_TEXT: Record<ProviderState, string> = {
  ready: "Ready",
  not_connected: "Not set up",
  not_logged_in: "Not logged in",
  not_installed: "Not installed",
  not_supported: "Not supported",
  error: "Not working",
};

/** Only a login the probe says is missing can be overridden ("Use anyway"); a missing command cannot. */
export function canUseAnyway(p: Pick<Provider, "kind" | "state">): boolean {
  return p.kind === "agent" && p.state === "not_logged_in";
}

/** What the "experimental" word says on hover (decision 2026-11-12). */
export const EXPERIMENTAL_TIP = "Octo has not tested this agent yet.";

/** The state as one or two words (rows, chips). */
export function stateText(state: ProviderState): string {
  return STATE_TEXT[state];
}

/**
 * The button a provider row shows (decision 53): Connect when it never worked, Reconnect when it did and stopped. An agent
 * that was never set up (not installed, not logged in) has nothing to press: its sheet lists the commands, so "How to connect".
 */
export function connectAction(p: Pick<Provider, "state" | "kind">): "Connect" | "Reconnect" | "How to connect" | "Manage" | "" {
  if (p.state === "ready") return "Manage";
  if (p.state === "not_supported") return "";
  if (p.state === "error") return "Reconnect";
  if (p.kind === "agent") return "How to connect";
  return "Connect";
}

/** The provider a new project would run on (the connect screen says which one, decision 53 b). */
export function providerOf(list: ProvidersResponse, value: string): Provider | undefined {
  if (value === "small" || value.startsWith("ollama:")) {
    return list.providers.find((p) => p.kind === "ollama");
  }
  if (value.startsWith("acp:")) {
    const id = value.slice(4).split("/")[0];
    return list.providers.find((p) => p.kind === "agent" && p.id === id);
  }
  return (
    list.providers.find((p) => (p.kind === "api" || p.kind === "router") && isReady(p) && p.models.some((m) => m.id === value)) ??
    list.providers.find((p) => (p.kind === "api" || p.kind === "router") && isReady(p))
  );
}
