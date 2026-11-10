import type { AgentStatus, Tier } from "@octo/agent-client";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/cn";

const LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  running: "working",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function statusLabel(status: AgentStatus): string {
  return LABEL[status];
}

/** `className` replaces the default colour (`text-fg-2`) when given. */
export function Spinner({ size = 12, className = "text-fg-2" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={cn("shrink-0 animate-spin", className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** One glyph per status: accent spinner, green check, red cross, grey dot. */
export function StatusIcon({ status, size = 12 }: { status: AgentStatus; size?: number }) {
  if (status === "running") return <Spinner size={size} className="text-accent" />;
  if (status === "completed") return <Check size={size} strokeWidth={2} absoluteStrokeWidth className="shrink-0 text-ok" aria-hidden />;
  if (status === "failed") return <X size={size} strokeWidth={2} absoluteStrokeWidth className="shrink-0 text-err" aria-hidden />;
  return (
    <span aria-hidden className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span className="size-[5px] rounded-full bg-fg-3" />
    </span>
  );
}

const TIER_LABEL: Record<Tier, string> = { fast: "fast", balanced: "balanced", deep: "deep" };

export function tierLabel(tier: Tier): string {
  return TIER_LABEL[tier];
}

export function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "balanced" || v === "deep";
}

export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
