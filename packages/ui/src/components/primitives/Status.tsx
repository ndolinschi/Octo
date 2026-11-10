import type { AgentStatus, Tier } from "@octo/agent-client";
import { Check, CircleSlash, X } from "lucide-react";
import { cn } from "../../lib/cn";

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

export function StatusDot({ status, className }: { status: AgentStatus | "pending"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        status === "running" && "animate-pulse-dot bg-accent",
        status === "pending" && "border border-fg-3",
        status === "completed" && "bg-ok",
        status === "failed" && "bg-err",
        (status === "cancelled" || status === "idle") && "bg-fg-3/70",
        className,
      )}
    />
  );
}

export function StatusIcon({ status, size = 13 }: { status: AgentStatus; size?: number }) {
  if (status === "running") return <StatusDot status="running" className="mx-[3px]" />;
  if (status === "completed") return <Check size={size} strokeWidth={2.25} className="text-ok" aria-hidden />;
  if (status === "failed") return <X size={size} strokeWidth={2.25} className="text-err" aria-hidden />;
  if (status === "cancelled") return <CircleSlash size={size - 1} strokeWidth={2} className="text-fg-3" aria-hidden />;
  return <StatusDot status="idle" className="mx-[3px]" />;
}

export function StatusLabel({ status, className }: { status: AgentStatus | "pending"; className?: string }) {
  if (status === "pending") return <span className={cn("text-xs text-fg-3", className)}>Starting</span>;
  return (
    <span
      className={cn(
        "text-xs",
        status === "running" && "shimmer-text font-medium",
        status === "completed" && "text-fg-3",
        status === "failed" && "text-err",
        (status === "cancelled" || status === "idle") && "text-fg-3",
        className,
      )}
    >
      {LABEL[status]}
    </span>
  );
}

const TIER_CLASS: Record<Tier, string> = {
  fast: "text-tier-fast",
  balanced: "text-tier-balanced",
  deep: "text-tier-deep",
};

const TIER_LABEL: Record<Tier, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };

export function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "balanced" || v === "deep";
}

export function TierBadge({ tier, model, compact }: { tier: Tier; model?: string; compact?: boolean }) {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-xs border border-line px-1.5 text-2xs font-medium whitespace-nowrap"
      title={model ? `${TIER_LABEL[tier]} tier · ${model}` : `${TIER_LABEL[tier]} tier`}
    >
      <span className={cn("inline-flex items-center gap-1", TIER_CLASS[tier])}>
        <TierGlyph tier={tier} />
        {TIER_LABEL[tier]}
      </span>
      {model && !compact && <span className="font-normal text-fg-3">{shortModel(model)}</span>}
    </span>
  );
}

function TierGlyph({ tier }: { tier: Tier }) {
  const bars = tier === "fast" ? 1 : tier === "balanced" ? 2 : 3;
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden className="shrink-0">
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={i * 3.25}
          y={6 - i * 2.5}
          width="2.25"
          height={3 + i * 2.5}
          rx="0.6"
          fill="currentColor"
          opacity={i < bars ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
