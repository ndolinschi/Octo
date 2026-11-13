import type { Plugin } from "@octo/agent-client";
import { Plug, Server, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { FilterTabs } from "../primitives/FilterTabs";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { SearchField } from "../primitives/SearchField";
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
 * Settings → Editor → Plugins (contract v6 decision 20; a section of the settings page since decision 59): what the harness loaded from local plugin manifests,
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
      <Notice
        form="block"
        tone="error"
        title="Couldn't load integrations"
        actions={
          <Button size="sm" onClick={fetch}>
            Retry
          </Button>
        }
      >
        {load.message}. Check that the harness is running, then retry.
      </Notice>
    );
  }

  return (
    <div data-integrations className="flex flex-col gap-3">
      <SearchField label="Search integrations" value={query} onChange={setQuery} />

      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs<Kind | "all">
          label="Show"
          value={kind}
          onChange={setKind}
          className="px-0"
          options={KINDS.map((k) => ({
            id: k.kind,
            label: k.label,
            count: k.kind === "all" ? matching.length : matching.filter((i) => i.kind === k.kind).length,
          }))}
        />
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
        <div role="list" aria-label="Integrations" className="grid grid-cols-2 gap-x-2 max-[560px]:grid-cols-1">
          {plugins.flatMap((p) => {
            const rows = shown.filter((i) => i.plugin === p.name);
            const errors = kind === "all" && !q ? p.errors : [];
            return [
              ...rows.map((i) => <IntegrationRow key={i.key} item={i} />),
              ...(errors.length
                ? [
                    <div
                      key={`${p.name}/errors`}
                      role="listitem"
                      aria-label={`Problems in ${p.name} ${p.version}`}
                      className="col-span-2 flex flex-col gap-1 px-2 pt-1 pb-2 max-[560px]:col-span-1"
                    >
                      {errors.map((e, n) => (
                        <Notice key={n} tone="error">
                          <span className="font-mono">{p.name}</span> {e}
                        </Notice>
                      ))}
                    </div>,
                  ]
                : []),
            ];
          })}
        </div>
      )}
      {problems.length > 0 && (kind !== "all" || q) && (
        <Notice tone="error">
          {problemCount}&nbsp;{problemCount === 1 ? "manifest problem" : "manifest problems"} (shown under All)
        </Notice>
      )}

      <p className="border-t border-line pt-3 text-xs text-fg-3">
        To add one, put a folder with a <code className="font-mono text-fg-2">plugin.json</code> in{" "}
        <code className="font-mono text-fg-2">{"{data-dir}"}/plugins/</code> or a directory passed with{" "}
        <code className="font-mono whitespace-nowrap text-fg-2">--plugins-dir</code>, then restart the harness.
      </p>
    </div>
  );
}

/** One 40px two-line row: kind glyph, name and detail, then the state and the plugin at the end. */
function IntegrationRow({ item: i }: { item: Item }) {
  return (
    <ListRow
      role="listitem"
      size="lg"
      tip={i.kind === "tool" ? `${i.plugin}: ${i.name}` : `${i.name} — ${i.detail} (${i.plugin})`}
      leading={<Glyph icon={KIND_ICON[i.kind]} size={14} />}
      title={<span className={cn(i.mono && i.kind === "tool" && "font-mono")}>{i.name}</span>}
      description={<span className={cn(i.mono && i.kind === "agent" && "font-mono")}>{i.detail}</span>}
      meta={
        <span className="flex items-center gap-3">
          {i.available !== null ? <State available={i.available} /> : <span>Configured</span>}
          <span className="font-mono">{i.plugin}</span>
        </span>
      }
    />
  );
}

function State({ available }: { available: boolean }) {
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5", available ? "text-fg-3" : "text-fg-2")}
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
