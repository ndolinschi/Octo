import type { AgentStatus, Tier } from "@octo/agent-client";
import { agentGlyph, orchestratorGlyph } from "../../lib/stateGlyph";
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

/** Something is running: the working ring centred in a `box`-sized square. */
export function RunningDot({ box = 12, className }: { box?: number; className?: string }) {
  return <StateGlyph state="working" size={box >= 16 ? 14 : 12} box={box} {...(className === undefined ? {} : { className })} />;
}

/**
 * The orchestrator's state in one 16px slot (sidebar rows, Home, the header): its ring at 14px — working (turning arc),
 * needs you (pulsing dot, `warn`), unseen activity (accent disc), not started (dashed), idle (thin ring).
 */
export function OrchestratorGlyph({ state, unseen = false }: { state: "working" | "needs" | "idle" | "new"; unseen?: boolean }) {
  return <StateGlyph state={orchestratorGlyph(state, unseen)} size={14} box={16} label />;
}
