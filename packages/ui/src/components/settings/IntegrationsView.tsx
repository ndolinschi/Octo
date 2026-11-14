import type { Plugin } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { useDelayedLoading } from "../../lib/hooksMore";
import { settingsHref } from "../../lib/route";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { ProviderMark } from "../primitives/ProviderMark";
import { SearchField } from "../primitives/SearchField";
import { SkeletonList } from "../primitives/Skeleton";
import { CONTROL_W, LoadErrorRow, SettingsGroup, SettingsRow } from "./parts";
import { plainPluginProblem } from "./pluginProblems";

type Kind = "server" | "agent" | "tool";
type Item = { key: string; kind: Kind; name: string; detail: string; tip: string; plugin: string; available: boolean | null; mark?: string };
type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; plugins: Plugin[] };

const GROUPS: { kind: Kind; label: string; footer: ReactNode }[] = [
  { kind: "server", label: "Language servers", footer: "They give the editor go to definition, hover, and errors as you type, per language." },
  {
    kind: "agent",
    label: "Agents",
    footer: (
      <>
        Agents that can answer or take on work. Log in and choose their models in{" "}
        <a href={settingsHref("providers")} className="text-link underline-offset-2 hover:underline">
          Providers
        </a>
        .
      </>
    ),
  },
  { kind: "tool", label: "Tool servers", footer: "Extra tools agents may call (MCP servers)." },
];

function itemsOf(plugins: Plugin[]): Item[] {
  return plugins.flatMap((p) => [
    ...p.language_servers.map((s): Item => ({
      key: `${p.name}/ls/${s.id}`,
      kind: "server",
      name: s.label,
      detail: s.languages.join(", "),
      tip: s.id,
      plugin: p.name,
      available: s.available,
    })),
    // B8: the agent's protocol id (`acp:claude-code`) is a tooltip, not the row's text.
    ...p.agents.map((a): Item => ({
      key: `${p.name}/agent/${a.id}`,
      kind: "agent",
      name: a.label,
      detail: "Agent",
      tip: `acp:${a.id}`,
      mark: a.id,
      plugin: p.name,
      available: a.available,
    })),
    ...p.tool_servers.map((t, i): Item => ({
      key: `${p.name}/tool/${i}`,
      kind: "tool",
      name: t.url.replace(/^https?:\/\//, ""),
      detail: t.url.startsWith("https") ? "Secure connection" : "Local connection",
      tip: t.url,
      plugin: p.name,
      available: null,
    })),
  ]);
}

/**
 * Settings → Integrations (B9; it was the "Plugins and language servers" group of Editor): what the plugins installed on this
 * computer add, read-only, in one group per kind — language servers, agents, tool servers. One-column rows: the name, then
 * what it is for and the plugin it comes from as the second line, and whether it was found. A manifest problem is said in plain
 * words under the group it is about, with the raw text under Details. No catalogue and no Connect: plugins are files.
 */
export function IntegrationsView() {
  const { bridge, health } = useApp();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");
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

  const plugins = useMemo(() => (load.status === "ready" ? load.plugins : []), [load]);
  const items = useMemo(() => itemsOf(plugins), [plugins]);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => `${i.name} ${i.detail} ${i.plugin} ${i.tip}`.toLowerCase().includes(q)) : items;
  const problems = plugins.flatMap((p) => p.errors.map((raw) => ({ plugin: p.name, raw, kind: kindOf(raw), text: plainPluginProblem(p.name, raw, plugins) })));

  if (load.status === "loading")
    return (
      <SettingsGroup label="Integrations">
        <div className={cn(!slow && "opacity-0")} aria-busy>
          <SkeletonList count={3} size="lg" twoLine />
        </div>
      </SettingsGroup>
    );
  if (load.status === "error")
    return (
      <SettingsGroup label="Integrations">
        <LoadErrorRow what="integrations" message={load.message} hint="Check that Octo's local service is running, then retry." onRetry={fetch} />
      </SettingsGroup>
    );

  return (
    <div data-integrations id="row-plugins" className="flex scroll-mt-6 flex-col gap-6">
      {items.length > 0 && (
        <div className="flex px-settings-inset">
          <SearchField label="Search integrations" value={query} onChange={setQuery} className={CONTROL_W.lg} />
        </div>
      )}
      {plugins.length === 0 && (
        <SettingsGroup label="Integrations">
          <SettingsRow title="No plugins installed" description="Plugins add language servers, agents and tool servers. See below how to add one." />
        </SettingsGroup>
      )}
      {plugins.length > 0 && q && shown.length === 0 && <p className="px-settings-inset text-sm text-fg-3">Nothing matches “{query.trim()}”.</p>}
      {GROUPS.map((g) => {
        const rows = shown.filter((i) => i.kind === g.kind);
        const own = q ? [] : problems.filter((p) => p.kind === g.kind || (p.kind === null && g.kind === "server"));
        if (rows.length === 0 && own.length === 0) return null;
        return (
          <SettingsGroup key={g.kind} label={g.label} footer={g.footer}>
            {rows.map((i) => (
              <SettingsRow
                key={i.key}
                // N9: an agent row starts with its vendor's mark, as the provider rows do.
                {...(i.mark ? { leading: <ProviderMark id={i.mark} label={i.name} className="text-fg-2" /> } : {})}
                title={<span title={i.tip}>{i.name}</span>}
                description={`${i.detail} · from ${i.plugin}`}
                control={i.available === null ? <span className="text-xs text-fg-3">Added</span> : <State available={i.available} />}
              />
            ))}
            {own.map((p, n) => (
              <Problem key={`${p.plugin}/${n}`} text={p.text} raw={p.raw} />
            ))}
          </SettingsGroup>
        );
      })}
      <p className="px-settings-inset text-xs text-fg-3">
        To add a plugin, put its folder (with a <code className="font-mono text-fg-2">plugin.json</code> file) in the{" "}
        <span title="{data-dir}/plugins/, or a folder passed with --plugins-dir">plugins folder inside the data folder</span> (Privacy and data shows where),
        then restart Octo.
      </p>
    </div>
  );
}

function kindOf(raw: string): Kind | null {
  if (raw.startsWith("languageServers")) return "server";
  if (raw.startsWith("agents")) return "agent";
  if (raw.startsWith("toolServers") || raw.startsWith("tool server")) return "tool";
  return null;
}

/** A manifest problem: the plain sentence, and the raw text behind "Details". */
function Problem({ text, raw }: { text: string; raw: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 px-settings-inset py-3">
      <Notice
        tone="warn"
        action={
          <Button variant="link" size="xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide details" : "Details"}
          </Button>
        }
      >
        {text}
      </Notice>
      {open && <code className="pl-6 font-mono text-xs break-all text-fg-3">{raw}</code>}
    </div>
  );
}

function State({ available }: { available: boolean }) {
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5 text-xs", available ? "text-fg-3" : "text-fg-2")}
      title={available ? "Available" : "Its program was not found on this computer"}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-ok" : "border border-fg-3")} />
      {available ? (
        "Available"
      ) : (
        <>
          Not found<span className="sr-only"> on this computer</span>
        </>
      )}
    </span>
  );
}
