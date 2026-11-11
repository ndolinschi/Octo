import type { Limit } from "@octo/agent-client";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import { isStale, limitKindLabel, observedLabel, remainingShare, remainingText, resetLabel, sortLimits } from "../../lib/usage";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { INFO_ROW, InfoSection, SkeletonRows } from "../primitives/InfoList";
import { modelLabel } from "../primitives/Status";
import { useLimits } from "./useUsage";

/** Below this share remaining, the bar turns `err` (colour means state). */
const LOW = 0.1;

function LimitRow({ limit, now }: { limit: Limit; now: number }) {
  const share = remainingShare(limit);
  const stale = isStale(limit.observed_at, now);
  const reset = resetLabel(limit.resets_at, now);
  const name = `${modelLabel(limit.model)} ${limitKindLabel(limit.kind).toLowerCase()}`;
  return (
    <div
      data-limit
      data-stale={stale ? "" : undefined}
      title={`${limit.model} on ${limit.provider}: ${limitKindLabel(limit.kind).toLowerCase()}${stale ? " — stale: no response with these headers for over 10 minutes" : ""}`}
      className={cn("flex flex-col gap-1 rounded-sm px-2 py-2", stale && "opacity-60")}
    >
      <div className="flex h-5 min-w-0 items-center gap-2 text-sm">
        {/* The model, then the kind muted: two runs with a gap, no "·" joiner. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
          <span className="shrink-0 text-fg">{modelLabel(limit.model)}</span>
          <span className="min-w-0 truncate text-fg-2">{limitKindLabel(limit.kind)}</span>
        </span>
        <span className="shrink-0 text-xs text-fg-2 tabular-nums">{remainingText(limit)}</span>
      </div>
      <span
        role="meter"
        aria-label={`${name} remaining`}
        aria-valuemin={0}
        aria-valuemax={limit.limit ?? 0}
        aria-valuenow={limit.remaining ?? 0}
        className="h-1 overflow-hidden rounded-full bg-line"
      >
        {share !== null && <span className={cn("block h-full rounded-full", share < LOW ? "bg-err" : "bg-fg-3")} style={{ width: `${share * 100}%` }} />}
      </span>
      <div className="flex h-4 items-center gap-3 text-xs text-fg-3 tabular-nums">
        {reset && <span>{reset}</span>}
        <span>{observedLabel(limit.observed_at, now)}</span>
        {stale && <span className="ml-auto">stale</span>}
      </div>
    </div>
  );
}

/**
 * Limits: one row per provider + model + kind from `getLimits()` (the latest rate-limit headers the harness saw) with
 * a bar of remaining / limit, a live reset countdown and when it was observed; rows older than 10 minutes are dimmed.
 * Plan limits of external (ACP) agents are not readable by the harness, so that section names the agents and says
 * where those limits are shown, without numbers.
 */
export function UsageLimits() {
  const { limits, agents } = useLimits();
  const now = useNow(true);
  const groups = useMemo(() => {
    if (limits.status !== "ok") return [];
    const by = new Map<string, Limit[]>();
    for (const l of sortLimits(limits.value)) by.set(l.provider, [...(by.get(l.provider) ?? []), l]);
    return [...by];
  }, [limits]);
  return (
    <>
      {limits.status === "loading" && <SkeletonRows count={4} />}
      {limits.status === "error" && (
        <p role="alert" className="px-2 text-sm text-fg-2">
          Couldn't read limits: {limits.message}. Check that the harness is running, then reopen this tab.
        </p>
      )}
      {limits.status === "ok" && groups.length === 0 && (
        <div className="flex flex-col gap-1 px-2 py-6 text-center">
          <p className="text-sm text-fg-2">No rate limits observed yet</p>
          <p className="text-xs text-fg-3">
            Limits appear after the first model response that carries rate-limit headers (they are kept until the harness restarts).
          </p>
        </div>
      )}
      {groups.map(([provider, rows]) => (
        <InfoSection key={provider} title={provider} labelId={`usage-limits-${provider}`}>
          {rows.map((l) => (
            <LimitRow key={`${l.model}/${l.kind}`} limit={l} now={now} />
          ))}
        </InfoSection>
      ))}
      <InfoSection title="Plan limits for external agents" labelId="usage-plan-limits">
        {agents.map((a) => (
          <div key={a.id} className={INFO_ROW}>
            <span className="grid size-4 shrink-0 place-items-center">
              <Glyph icon={GLYPH.agent} size={14} className="text-fg-3" />
            </span>
            <span className="min-w-0 truncate text-fg-2">{a.label}</span>
            <span className="ml-auto shrink-0 text-xs text-fg-3">ACP agent</span>
          </div>
        ))}
        <p className="px-2 pt-1 text-xs text-fg-3">
          {agents.length
            ? "Plan limits (five-hour, weekly) are shown by each agent's own CLI; the harness cannot read them."
            : "No external agents are available."}
        </p>
      </InfoSection>
    </>
  );
}
