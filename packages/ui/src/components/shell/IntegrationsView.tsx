import type { Plugin } from "@octo/agent-client";
import { CircleX, Plug, Search, Server, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Spinner } from "../primitives/Status";
import { errorMessage } from "../../lib/format";

type Kind = "server" | "agent" | "tool";
type Item = { key: string; kind: Kind; name: string; detail: string; plugin: string; available: boolean | null; mono: boolean };
type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; plugins: Plugin[] };

const KINDS: { kind: Kind | "all"; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "server", label: "Language servers" },
  { kind: "agent", label: "Agents" },
  { kind: "tool", label: "Tool servers" },
];
const KIND_ICON: Record<Kind, LucideIcon> = { server: Server, agent: GLYPH.agent, tool: Plug };

function itemsOf(plugins: Plugin[]): Item[] {
  return plugins.flatMap((p) => [
    ...p.language_servers.map((s): Item => ({
      key: `${p.name}/ls/${s.id}`,
      kind: "server",
      name: s.label,
      detail: s.languages.join(", "),
      plugin: p.name,
      available: s.available,
      mono: false,
    })),
    ...p.agents.map((a): Item => ({
      key: `${p.name}/agent/${a.id}`,
      kind: "agent",
      name: a.label,
      detail: `acp:${a.id}`,
      plugin: p.name,
      available: a.available,
      mono: true,
    })),
    ...p.tool_servers.map((t, i): Item => ({
      key: `${p.name}/tool/${i}`,
      kind: "tool",
      name: t.url.replace(/^https?:\/\//, ""),
      detail: t.url.startsWith("https") ? "Tool server, HTTPS" : "Tool server",
      plugin: p.name,
      available: null,
      mono: true,
    })),
  ]);
}

/**
 * Settings → Integrations (contract v6 decision 20): what the harness loaded from local plugin manifests,
 * read-only. Search, kind chips with counts, a summary, then two columns of 40px rows (one under 560px):
 * kind tile, name, one muted line, the plugin, and whether its command was found. Manifest problems are
 * listed under their plugin; the footer says how to add one. No catalogue and no Connect: plugins are files.
 */
export function IntegrationsView() {
  const { bridge, health } = useApp();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const slow = useDelayedLoading(load.status === "loading");

  const fetch = useCallback(() => {
    setLoad({ status: "loading" });
    bridge.listPlugins().then(
      (plugins) => setLoad({ status: "ready", plugins }),
      (e: unknown) => setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
  }, [bridge]);
  useEffect(() => {
    if (health === "online") fetch();
  }, [fetch, health]);

  const plugins = load.status === "ready" ? load.plugins : [];
  const items = useMemo(() => itemsOf(plugins), [plugins]);
  const q = query.trim().toLowerCase();
  const matching = useMemo(() => (q ? items.filter((i) => `${i.name} ${i.detail} ${i.plugin}`.toLowerCase().includes(q)) : items), [items, q]);
  const shown = kind === "all" ? matching : matching.filter((i) => i.kind === kind);
  const available = items.filter((i) => i.available === true).length;
  const missing = items.filter((i) => i.available === false).length;
  const problems = plugins.filter((p) => p.errors.length > 0);
  const problemCount = problems.reduce((n, p) => n + p.errors.length, 0);

  if (load.status === "loading") {
    return (
      <p className="flex h-9 items-center gap-2 text-xs text-fg-3" aria-busy>
        {slow && (
          <>
            <Spinner size={10} /> Loading integrations…
          </>
        )}
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <p className="min-w-0 flex-1 text-fg-2">
          <span className="text-err">Couldn't load integrations.</span> {load.message}. Check that the harness is running, then retry.
        </p>
        <Button size="sm" onClick={fetch}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div data-integrations className="flex flex-col gap-3">
      <label className="flex h-row-nav items-center gap-2 rounded-md border border-input-border px-3 text-fg-3 transition-[border-color] duration-100 focus-within:border-focus">
        <Glyph icon={Search} size={14} className="shrink-0" />
        <span className="sr-only">Search integrations</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
          data-esc-clears
          placeholder="Search integrations"
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => {
            const count = k.kind === "all" ? matching.length : matching.filter((i) => i.kind === k.kind).length;
            const on = kind === k.kind;
            return (
              <button
                key={k.kind}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(k.kind)}
                className={cn(
                  "flex h-chip press items-center gap-1.5 rounded-sm border px-2 text-xs",
                  on ? "border-transparent bg-active text-fg" : "border-line text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                {k.label}
                {/* On the selected chip's fill, fg-3 fell under 4.5:1 (decision 36): the count takes fg-2 there. */}
                <span className={cn("tabular-nums", on ? "text-fg-2" : "text-fg-3")}>{count}</span>
              </button>
            );
          })}
        </div>
        <p className="ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums">
          <span className="text-fg-2">{available}&nbsp;available</span>
          {missing > 0 && <span className="text-fg-3">{missing}&nbsp;not found</span>}
        </p>
      </div>

      {plugins.length === 0 ? (
        <p className="text-sm text-fg-2">No plugins loaded.</p>
      ) : shown.length === 0 ? (
        <p className="flex h-bar items-center text-sm text-fg-3">No integrations match.</p>
      ) : (
        // Rows stay together per plugin (in manifest order); a plugin's manifest problems follow its rows,
        // full width, so each error sits with what it is about.
        <ul aria-label="Integrations" className="grid grid-cols-2 gap-x-2 max-[560px]:grid-cols-1">
          {plugins.flatMap((p) => {
            const rows = shown.filter((i) => i.plugin === p.name);
            const errors = kind === "all" && !q ? p.errors : [];
            return [
              ...rows.map((i) => <IntegrationRow key={i.key} item={i} />),
              ...(errors.length
                ? [
                    <li
                      key={`${p.name}/errors`}
                      aria-label={`Problems in ${p.name} ${p.version}`}
                      className="col-span-2 flex flex-col gap-1 px-1.5 pt-1 pb-2 max-[560px]:col-span-1"
                    >
                      {errors.map((e, n) => (
                        <p key={n} className="flex items-start gap-2 text-xs text-err">
                          <span className="grid h-4 shrink-0 place-items-center">
                            <Glyph icon={CircleX} size={14} />
                          </span>
                          <span className="min-w-0 wrap-anywhere">
                            <span className="font-mono">{p.name}</span> {e}
                          </span>
                        </p>
                      ))}
                    </li>,
                  ]
                : []),
            ];
          })}
        </ul>
      )}
      {problems.length > 0 && (kind !== "all" || q) && (
        <p className="text-xs text-err">
          {problemCount}&nbsp;{problemCount === 1 ? "manifest problem" : "manifest problems"} (shown under All)
        </p>
      )}

      <p className="border-t border-line pt-3 text-xs text-fg-3">
        To add one, put a folder with a <code className="font-mono text-fg-2">plugin.json</code> in{" "}
        <code className="font-mono text-fg-2">{"{data-dir}"}/plugins/</code> or a directory passed with{" "}
        <code className="font-mono whitespace-nowrap text-fg-2">--plugins-dir</code>, then restart the harness.
      </p>
    </div>
  );
}

/** [28 tile] 8 [name / detail] … [state / plugin]: one 40px row (a 26-character name fits beside its state at 640px). */
function IntegrationRow({ item: i }: { item: Item }) {
  const Icon = KIND_ICON[i.kind];
  return (
    <li
      data-row
      className="flex h-bar min-w-0 items-center gap-2 rounded-sm px-1.5"
      title={i.kind === "tool" ? `${i.plugin}: ${i.name}` : `${i.name} — ${i.detail} (${i.plugin})`}
    >
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-sm bg-hover text-fg-2">
        <Glyph icon={Icon} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-sm text-fg", i.mono && i.kind === "tool" && "font-mono text-xs")}>{i.name}</span>
          {i.available !== null ? (
            <State available={i.available} />
          ) : (
            // No availability check exists for tool servers: the manifest names them, nothing more.
            <span className="ml-auto shrink-0 text-xs text-fg-3">Configured</span>
          )}
        </span>
        <span className="flex h-4 min-w-0 items-center gap-2 text-xs text-fg-3">
          <span className={cn("min-w-0 truncate", i.mono && i.kind === "agent" && "font-mono")}>{i.detail}</span>
          <span className="ml-auto shrink-0 font-mono">{i.plugin}</span>
        </span>
      </span>
    </li>
  );
}

function State({ available }: { available: boolean }) {
  return (
    <span
      className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-xs", available ? "text-fg-3" : "text-fg-2")}
      title={available ? "Available" : "Not found on this machine"}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-ok" : "border border-fg-3")} />
      {available ? (
        "Available"
      ) : (
        <>
          Not found<span className="sr-only"> on this machine</span>
        </>
      )}
    </span>
  );
}
