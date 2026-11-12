import type { Provider } from "@octo/agent-client";
import { KeyRound } from "lucide-react";
import { cn } from "../../lib/cn";
import { API_PROVIDER, connectAction, extraReason, isReady, stateText, useProviders } from "../../lib/providers";
import { STREAK_HERO } from "../../lib/streakPresets";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { SkeletonRows } from "../primitives/InfoList";
import { StreakLayer } from "../primitives/StreakLayer";

/**
 * Decision 53 b: with no provider connected, Home and "New project" show this instead of a project form — the agents
 * found on this machine with their state (each opens its connect sheet with the exact commands), the router, and "Use
 * an API key". One connected provider is enough; the line under the list says which one new projects would use.
 */
export function ConnectScreen({ onConnect }: { onConnect(target: string): void }) {
  const { bridge, theme, backdrop } = useApp();
  const providers = useProviders(bridge);
  const list = providers.status === "loading" ? null : providers.list;
  const agents = list?.providers.filter((p) => p.kind === "agent") ?? [];
  const others = list?.providers.filter((p) => p.kind !== "agent") ?? [];
  const refreshing = providers.status === "ready" && providers.refreshing;
  return (
    <section aria-labelledby="connect-title" data-connect className="relative h-full overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_HERO} theme={theme} mono={backdrop === "mono"} />}
      <div data-start-scroll className="relative h-full overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="relative mx-auto flex min-h-full w-full max-w-connect flex-col justify-center gap-6 px-6 py-8 max-sm:px-4">
          <div className="relative flex flex-col gap-2 text-center">
            {/* The streak's bright band runs behind the title: the panel-coloured wash keeps it readable (≥ 4.5:1), as on Home. */}
            {backdrop !== "off" && <span aria-hidden className="octo-streak-scrim" />}
            <h1 id="connect-title" className="relative text-display text-fg">
              <span className="octo-lead">Connect a provider</span> to start.
            </h1>
            <p className="relative text-sm text-fg-2">Octo runs models through an agent on this machine, an API key, or the Octo router. One is enough.</p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="px-1 text-xs text-fg-3">Agents on this machine</h2>
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">
              {providers.status === "loading" && (
                <li className="px-4 py-3">
                  <SkeletonRows count={3} />
                </li>
              )}
              {providers.status === "error" && !list && (
                <li role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-fg-2">
                  <span className="min-w-0 flex-1">
                    <span className="text-err">Couldn't check this machine.</span> {providers.message.replace(/\.$/, "")}. Check that the harness is running.
                  </span>
                  <Button size="sm" onClick={() => void providers.refresh()}>
                    Retry
                  </Button>
                </li>
              )}
              {list && agents.length === 0 && <li className="px-4 py-3 text-sm text-fg-3">No agent plugins are installed. Use an API key below.</li>}
              {agents.map((p) => (
                <ProviderLine key={p.id} provider={p} onConnect={onConnect} />
              ))}
            </ul>
          </div>

          {others.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="px-1 text-xs text-fg-3">Or pay per token</h2>
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">
                {others.map((p) => (
                  <ProviderLine key={p.id} provider={p} onConnect={onConnect} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button variant="primary" icon={KeyRound} onClick={() => onConnect(API_PROVIDER)}>
              Use an API key
            </Button>
            <Button onClick={() => void providers.refresh()} disabled={refreshing || providers.status === "loading"} aria-busy={refreshing}>
              {refreshing ? "Checking…" : "Check again"}
            </Button>
          </div>
          <p className="text-center text-xs text-fg-3">The first provider you connect runs new projects. Change it later in Settings → Models.</p>
        </div>
      </div>
    </section>
  );
}

function ProviderLine({ provider: p, onConnect }: { provider: Provider; onConnect(target: string): void }) {
  const tone = isReady(p) ? "bg-ok" : p.state === "not_connected" ? "bg-fg-3" : p.state === "error" ? "bg-err" : "bg-warn";
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone)} />
      <span className="min-w-0 flex-1">
        <span className="block text-base text-fg">{p.label}</span>
        <span className="block text-sm text-fg-3">
          {stateText(p.state)}
          {extraReason(p) && !isReady(p) ? ` · ${extraReason(p)}` : ""}
        </span>
      </span>
      <Button
        size="sm"
        variant={isReady(p) ? "secondary" : "primary"}
        onClick={() => onConnect(p.id)}
        aria-label={`${connectAction(p) === "Manage" ? "Details" : connectAction(p)}: ${p.label}`}
      >
        {connectAction(p) === "Manage" ? "Details" : connectAction(p)}
      </Button>
    </li>
  );
}
