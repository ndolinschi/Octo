import { useApp } from "../../state/app";
import type { Limit } from "@octo/agent-client";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { useNow, usePageVisible } from "../../lib/hooks";
import { toolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { isStale, limitKindLabel, observedLabel, remainingShare, remainingText, resetLabel, sortLimits, spentShare } from "../../lib/usage";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { InfoSection } from "../primitives/InfoList";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { PanelEmpty } from "../primitives/Panel";
import { SkeletonList } from "../primitives/Skeleton";
import { modelLabel } from "../primitives/Status";
import { useLimits } from "./useUsage";

/** Below this share remaining, the bar turns `err` (colour means state): only a limit nearly used up is red. */
const LOW = 0.1;

function LimitRow({ limit, now }: { limit: Limit; now: number }) {
  const left = remainingShare(limit);
  // B43: the bar is what is spent (it grows as the limit is used), the words say what is left.
  const spent = spentShare(limit);
  const stale = isStale(limit.observed_at, now);
  const reset = resetLabel(limit.resets_at, now);
  const name = `${modelLabel(limit.model)} ${limitKindLabel(limit.kind).toLowerCase()}`;
  return (
    <div
      data-limit
      data-stale={stale ? "" : undefined}
      title={`${limit.model} on ${limit.provider}: ${limitKindLabel(limit.kind).toLowerCase()}${stale ? " — stale: no response with these headers for over 10 minutes" : ""}`}
      className="flex flex-col gap-1 rounded-sm px-2 py-2"
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
        {...(limit.limit
          ? { role: "meter", "aria-label": `${name} remaining`, "aria-valuemin": 0, "aria-valuemax": limit.limit, "aria-valuenow": limit.remaining ?? 0 }
          : { "aria-hidden": true })}
        className="h-1 overflow-hidden rounded-full bg-line"
      >
        {spent !== null && left !== null && (
          <span className={cn("block h-full min-w-0.5 rounded-full", left < LOW ? "bg-err" : "bg-fg-3")} style={{ width: `${spent * 100}%` }} />
        )}
      </span>
      <div className="flex h-4 items-center gap-3 text-xs text-fg-3 tabular-nums">
        {reset && <span>{reset}</span>}
        <span>{observedLabel(limit.observed_at, now)}</span>
        {/* Stale is said, not dimmed (decision 36: a dimmed block fell under 4.5:1). */}
        {stale && <span className="ml-auto text-fg-2">Stale</span>}
      </div>
    </div>
  );
}

/**
 * Limits: one row per provider + model + kind from `getLimits()` (the latest rate-limit headers the harness saw) with
 * a bar of remaining / limit, a live reset countdown and when it was observed; rows older than 10 minutes say "Stale".
 * Plan limits of external (ACP) agents are not readable by the harness, so that section names the agents and says
 * where those limits are shown, without numbers.
 */
export function UsageLimits() {
  const ws = useWorkspace();
  const { config } = useApp();
  // Decision 36: nothing polls or ticks while the Usage tab is hidden (it stays mounted) or the page is.
  const pageVisible = usePageVisible();
  const shown = ws.isVisible(toolTab("usage")) && pageVisible;
  const { limits, agents } = useLimits(shown);
  const now = useNow(true, undefined, !shown);
  const groups = useMemo(() => {
    if (limits.status !== "ok") return [];
    const by = new Map<string, Limit[]>();
    for (const l of sortLimits(limits.value)) by.set(l.provider, [...(by.get(l.provider) ?? []), l]);
    return [...by];
  }, [limits]);
  return (
    <>
      {limits.status === "loading" && <SkeletonList count={4} size="md" />}
      {limits.status === "error" && (
        <Notice form="block" tone="error" title="Couldn't read limits">
          {limits.message}. Check that the harness is running, then reopen this tab.
        </Notice>
      )}
      {limits.status === "ok" && groups.length === 0 && (
        // P1: a section with nothing to show says so in the frame's one empty line, under its caption like the others.
        <InfoSection title="Rate limits" labelId="usage-limits-none">
          <div data-limits-empty>
            <PanelEmpty>
              {config?.router
                ? "The router reports no rate limits: the provider behind it (OpenRouter, for one) sends no rate-limit headers. They appear when a provider that sends them, such as Anthropic's API, answers."
                : "None reported yet. Limits appear after the first model response that carries rate-limit headers; some providers (OpenRouter, for one) send none."}
            </PanelEmpty>
          </div>
        </InfoSection>
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
          <ListRow key={a.id} leading={<Glyph icon={GLYPH.agent} size={14} />} title={a.label} meta="ACP agent" tone="quiet" />
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
