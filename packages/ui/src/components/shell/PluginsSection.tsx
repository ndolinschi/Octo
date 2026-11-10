import type { Plugin } from "@octo/agent-client";
import { CircleX, Puzzle } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
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
    // Row anatomy: [32px icon tile] 12 [name + version / description / parts] … [state].
    <li className="flex gap-3 p-3" aria-label={`${p.name} ${p.version}`}>
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-hover text-fg-2">
        <Glyph icon={Puzzle} size={16} />
      </span>
      <div className="min-w-0 flex-1">
      <div className="flex h-5 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-fg">{p.name}</span>
        <span className="shrink-0 text-xs text-fg-3 tabular-nums">{p.version}</span>
        <PluginState plugin={p} />
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
              <span className="grid h-4 shrink-0 place-items-center">
                <Glyph icon={CircleX} size={14} />
              </span>
              <span className="min-w-0 wrap-anywhere">{e}</span>
            </li>
          ))}
        </ul>
      )}
      </div>
    </li>
  );
}

/** One summary on the name line's right: problems first, then whether every command was found. */
function PluginState({ plugin: p }: { plugin: Plugin }) {
  const missing = [...p.language_servers, ...p.agents].filter((x) => !x.available).length;
  const text = p.errors.length ? `${p.errors.length}\u00a0${p.errors.length === 1 ? "problem" : "problems"}` : missing ? "Partly available" : "Ready";
  return <span className={cn("ml-auto shrink-0 text-xs", p.errors.length ? "text-err" : missing ? "text-fg-2" : "text-fg-3")}>{text}</span>;
}

function Availability({ available }: { available: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", available ? "text-fg-3" : "text-fg-2")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-ok" : "border border-fg-3")} />
      {available ? "Available" : "Not found on this machine"}
    </span>
  );
}
