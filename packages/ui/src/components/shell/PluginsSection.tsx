import type { Plugin } from "@octo/agent-client";
import { CircleX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Spinner } from "../primitives/Status";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; plugins: Plugin[] };

/**
 * Settings → Plugins: what the harness loaded at startup (read-only; installing a plugin is a
 * local file operation, there is no API for it). Each plugin lists its language servers, agents and
 * tool servers with whether their command was found, and any manifest problems.
 */
export function PluginsSection() {
  const { bridge, health } = useApp();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const slow = useDelayedLoading(load.status === "loading");

  const fetch = useCallback(() => {
    setLoad({ status: "loading" });
    bridge.listPlugins().then(
      (plugins) => setLoad({ status: "ready", plugins }),
      (e: unknown) => setLoad({ status: "error", message: (e instanceof Error ? e.message : String(e)).replace(/\.$/, "") }),
    );
  }, [bridge]);
  useEffect(() => {
    if (health === "online") fetch();
  }, [fetch, health]);

  return (
    <section aria-labelledby="octo-plugins-heading">
      <h3 id="octo-plugins-heading" className="text-sm text-fg-2">
        Plugins
      </h3>
      {load.status === "loading" ? (
        <p className="mt-1.5 flex h-9 items-center gap-2 text-xs text-fg-3" aria-busy>
          {slow && (
            <>
              <Spinner size={10} /> Loading plugins…
            </>
          )}
        </p>
      ) : load.status === "error" ? (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <p className="min-w-0 flex-1 text-fg-2">
            <span className="text-err">Couldn't load plugins.</span> {load.message}.
          </p>
          <Button size="sm" onClick={fetch}>
            Retry
          </Button>
        </div>
      ) : load.plugins.length === 0 ? (
        <p className="mt-1.5 text-sm text-fg-2">
          No plugins loaded. Plugins are folders with a <code className="font-mono text-xs text-fg">plugin.json</code>, read from{" "}
          <code className="font-mono text-xs text-fg">{"{data-dir}"}/plugins/</code> or <code className="font-mono text-xs text-fg">--plugins-dir</code> when the
          harness starts.
        </p>
      ) : (
        <>
          <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-md border border-line bg-panel">
            {load.plugins.map((p) => (
              <PluginItem key={p.name} plugin={p} />
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-fg-3">
            Read when the harness starts, from <code className="font-mono">{"{data-dir}"}/plugins/</code> and <code className="font-mono">--plugins-dir</code>.
          </p>
        </>
      )}
    </section>
  );
}

type Part = { kind: string; name: string; detail?: string; available: boolean | null; mono?: boolean };

function PluginItem({ plugin: p }: { plugin: Plugin }) {
  const parts: Part[] = [
    ...p.language_servers.map((s) => ({ kind: "Language server", name: s.label, detail: s.languages.join(", "), available: s.available })),
    ...p.agents.map((a) => ({ kind: "Agent", name: a.label, available: a.available })),
    ...p.tool_servers.map((t) => ({ kind: "Tool server", name: t.url, available: null, mono: true })),
  ];
  return (
    <li className="px-3 py-2.5" aria-label={`${p.name} ${p.version}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-sm text-fg">{p.name}</span>
        <span className="shrink-0 text-xs text-fg-3 tabular-nums">{p.version}</span>
      </div>
      {p.description && <p className="mt-0.5 text-xs text-fg-3">{p.description}</p>}
      {parts.length > 0 && (
        <ul className="mt-2 flex flex-col">
          {parts.map((part, i) => (
            <li key={i} className="grid min-h-7 grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-x-3 text-xs max-[420px]:grid-cols-[minmax(0,1fr)_auto]">
              <span className="text-fg-3 max-[420px]:hidden">{part.kind}</span>
              <span className="min-w-0 truncate" title={part.detail ? `${part.name} (${part.detail})` : part.name}>
                <span className={cn("text-fg", part.mono && "font-mono")}>{part.name}</span>
                {part.detail && <span className="ml-2 text-fg-3">{part.detail}</span>}
              </span>
              {part.available !== null && <Availability available={part.available} />}
            </li>
          ))}
        </ul>
      )}
      {p.errors.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Manifest problems">
          {p.errors.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-err">
              <CircleX size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Availability({ available }: { available: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", available ? "text-fg-3" : "text-fg-2")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-ok" : "border border-fg-3")} />
      {available ? "Available" : "Not found on this machine"}
    </span>
  );
}
