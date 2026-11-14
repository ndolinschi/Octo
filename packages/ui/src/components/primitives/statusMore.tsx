import type { AgentStatus, Tier } from "@octo/agent-client";
import { agentGlyph } from "../../lib/stateGlyph";
import { modelName } from "../../lib/models";
import { StateGlyph } from "./StateGlyph";

/* Status words and rings only lazily loaded views show (agent header, delegations, details, usage): out of `Status.tsx`,
 * which the entry chunk carries whole. */

const LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusLabel(status: AgentStatus): string {
  return LABEL[status];
}

/** An agent's state as its ring (decision 29): working, failed, or the quiet done / idle ring. */
export function StatusIcon({ status, size = 14, unseen = false }: { status: AgentStatus; size?: 14 | 16; unseen?: boolean }) {
  return <StateGlyph state={agentGlyph(status, unseen)} size={size === 16 ? 14 : 12} box={size} />;
}

const TIER_LABEL: Record<Tier, string> = { fast: "fast", balanced: "balanced", deep: "deep" };

export function tierLabel(tier: Tier): string {
  return TIER_LABEL[tier];
}

export function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "balanced" || v === "deep";
}

/** A model setting as people read it ("Sonnet 5.5", "Claude Code · Opus 5.5"): `lib/models.ts`, without agent labels. */
export function modelLabel(model: string): string {
  return modelName(model);
}
