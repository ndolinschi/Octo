import type { Agent, LanguageServerInfo, PluginAgent } from "@octo/agent-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { fileName, parentPath } from "../../lib/files";
import { formatRelative, formatTokens, middleTruncate } from "../../lib/format";
import { useDelayedLoading, useNow, useScrollFade } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useCode } from "../../state/code";
import { useProject } from "../../state/project";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { INFO_ROW, INFO_ROW_BUTTON, InfoSection, MoreRow, SkeletonRows } from "../primitives/InfoList";
import { modelLabel, StatusIcon } from "../primitives/Status";
import { groupWrites, useWrittenFiles } from "./useWrittenFiles";
import { Server } from "lucide-react";

/** Rows shown before "Show all" / "Show more" (contract v6 decision 17). */
const PAGE = 8;
const TIERS = [
  ["orchestrator", "Orchestrator"],
  ["fast", "Fast"],
  ["balanced", "Balanced"],
  ["deep", "Deep"],
] as const;

const roleOf = (a: Agent) => (a.parent_id === null ? "Orchestrator" : a.role || "Agent");
const isAcp = (a: Agent) => a.model.startsWith("acp:");

/**
 * The Details tab (contract v6 decisions 15 and 17): what this project is and what it has done, from real
 * data only — Folders, Models, Tokens per agent, Plugins in use, Activity and Files written. No share of a
 * context window: the harness reports none per project.
 */
export function DetailsPanel() {
  const { project } = useProject();
  const scroller = useRef<HTMLDivElement>(null);
  // Rows reaching the fold fade out instead of being cut (the list's scrollbar is hidden, like the sidebar's).
  useScrollFade(scroller, "y");
  if (!project) return null;
  return (
    <div ref={scroller} data-details className="fade-y h-full min-h-0 overflow-y-auto overscroll-contain px-pane pt-pane pb-4">
      <div className="flex flex-col gap-2">
        <Folders />
        <Models />
        <Tokens />
        <PluginsInUse />
        <Activity />
        <FilesWritten />
      </div>
      <FloatRoom />
    </div>
  );
}

function Folders() {
  const { project } = useProject();
  const code = useCode();
  const folders = project?.folders ?? [];
  return (
    <InfoSection title="Folders" labelId="details-folders">
      {folders.length === 0 && <p className={cn(INFO_ROW, "text-fg-3")}>No folders attached.</p>}
      {folders.map((f) => (
        <button key={f.id} type="button" title={f.path} onClick={() => code.revealDir(f.label, "")} className={INFO_ROW_BUTTON}>
          <Glyph icon={GLYPH.files} size={14} className="shrink-0 text-fg-3" />
          <span className="shrink-0 text-fg">{f.label}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-xs text-fg-3">{middleTruncate(f.path, 40)}</span>
        </button>
      ))}
    </InfoSection>
  );
}

function Models() {
  const { project } = useProject();
  if (!project) return null;
  return (
    <InfoSection title="Models" labelId="details-models">
      {TIERS.map(([key, label]) => (
        <div key={key} className={INFO_ROW}>
          <span className="shrink-0 text-fg-2">{label}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-fg" title={project.models[key]}>
            {modelLabel(project.models[key])}
          </span>
        </div>
      ))}
    </InfoSection>
  );
}

type TokenRow = { key: string; role: string; count: number; input: number; output: number; approx: boolean; title: string };

/** The orchestrator first, then one row per role (agents of the same role summed, with a count), by total. */
function tokenRows(agents: Agent[]): TokenRow[] {
  const rows = new Map<string, TokenRow>();
  for (const a of agents) {
    const key = a.parent_id === null ? "orchestrator" : `${isAcp(a) ? "acp:" : ""}${roleOf(a)}`;
    const row = rows.get(key) ?? { key, role: roleOf(a), count: 0, input: 0, output: 0, approx: false, title: "" };
    row.count += 1;
    row.input += a.input_tokens;
    row.output += a.output_tokens;
    row.approx ||= isAcp(a);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, title: `${r.role}${r.count > 1 ? ` (${r.count} agents)` : ""} — ${r.input.toLocaleString()} in, ${r.output.toLocaleString()} out${r.approx ? " (approximate)" : ""}` }))
    .sort((a, b) => Number(b.key === "orchestrator") - Number(a.key === "orchestrator") || b.input + b.output - (a.input + a.output));
}

function Tokens() {
  const { state } = useProject();
  const [all, setAll] = useState(false);
  const agents = useMemo(() => state.agentOrder.map((id) => state.agents[id]).filter((a): a is Agent => a !== undefined), [state.agentOrder, state.agents]);
  const rows = useMemo(() => tokenRows(agents), [agents]);
  const totalIn = agents.reduce((n, a) => n + a.input_tokens, 0);
  const totalOut = agents.reduce((n, a) => n + a.output_tokens, 0);
  const max = Math.max(1, ...rows.map((r) => r.input + r.output));
  const shown = all ? rows : rows.slice(0, PAGE);
  return (
    <InfoSection title="Tokens" labelId="details-tokens" aside={<span className="shrink-0">in / out</span>}>
      <div className={INFO_ROW}>
        <span className="shrink-0 text-fg">Total</span>
        <span className="ml-auto shrink-0 text-fg tabular-nums">
          {formatTokens(totalIn)} / {formatTokens(totalOut)}
        </span>
      </div>
      {shown.map((r) => (
        <div key={r.key} className={INFO_ROW} title={r.title}>
          <span className="flex w-[40%] min-w-0 shrink-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-fg-2">{r.role}</span>
            {r.count > 1 && <span className="shrink-0 text-xs text-fg-3 tabular-nums">×{r.count}</span>}
          </span>
          {/* A 2px bar, proportional to the largest row: who is spending. */}
          <span aria-hidden className="h-0.5 min-w-0 flex-1 rounded-full bg-line">
            <span className="block h-full rounded-full bg-fg-3" style={{ width: `${Math.max(2, ((r.input + r.output) / max) * 100)}%` }} />
          </span>
          {r.approx && <span className="shrink-0 text-xs text-fg-3">approx.</span>}
          <span className="shrink-0 text-xs text-fg-2 tabular-nums">
            {formatTokens(r.input)} / {formatTokens(r.output)}
          </span>
        </div>
      ))}
      {rows.length > PAGE && <MoreRow label={all ? "Show fewer" : `Show all (${rows.length})`} expanded={all} onClick={() => setAll((x) => !x)} />}
    </InfoSection>
  );
}

type PluginsLoad = { servers: LanguageServerInfo[]; agents: PluginAgent[] } | null;

function PluginsInUse() {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const [load, setLoad] = useState<PluginsLoad>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([bridge.listLanguageServers(projectId), bridge.listPlugins()]).then(
      ([servers, plugins]) => !cancelled && setLoad({ servers: servers.filter((s) => s.available), agents: plugins.flatMap((p) => p.agents).filter((a) => a.available) }),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId]);
  const slow = useDelayedLoading(load === null && !failed);
  const empty = load !== null && load.servers.length + load.agents.length === 0;
  return (
    <InfoSection title="Plugins in use" labelId="details-plugins">
      {failed && <p className={cn(INFO_ROW, "text-fg-3")}>Couldn't read the plugins. Reopen this tab to try again.</p>}
      {load === null && !failed && (
        // The skeleton holds its room from the start and shows only once loading is slow (no jump either way).
        <div className={cn(!slow && "opacity-0")}>
          <SkeletonRows count={2} />
        </div>
      )}
      {empty && <p className={cn(INFO_ROW, "text-fg-3")}>No language servers or agents available.</p>}
      {load?.servers.map((s) => (
        <div key={s.id} className={INFO_ROW}>
          <Glyph icon={Server} size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 shrink-0 truncate text-fg">{s.label}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-xs text-fg-3">{s.languages.join(", ")}</span>
        </div>
      ))}
      {load?.agents.map((a) => (
        <div key={a.id} className={INFO_ROW}>
          <Glyph icon={GLYPH.agent} size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 shrink-0 truncate text-fg">{a.label}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-xs text-fg-3">ACP agent</span>
        </div>
      ))}
    </InfoSection>
  );
}

function Activity() {
  const { state } = useProject();
  const ws = useWorkspace();
  const [all, setAll] = useState(false);
  const now = useNow(true, 60_000);
  const agents = useMemo(
    () =>
      state.agentOrder
        .map((id) => state.agents[id])
        .filter((a): a is Agent => a !== undefined && a.parent_id !== null)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [state.agentOrder, state.agents],
  );
  const shown = all ? agents : agents.slice(0, PAGE);
  return (
    <InfoSection title="Activity" labelId="details-activity">
      {agents.length === 0 && <p className={cn(INFO_ROW, "text-fg-3")}>No agents have run yet.</p>}
      {shown.map((a) => (
        <button key={a.id} type="button" onClick={(e) => ws.openAgent(a.id, { otherSide: e.altKey })} title={a.title ? `${roleOf(a)}: ${a.title}` : roleOf(a)} className={INFO_ROW_BUTTON}>
          <span className="grid size-4 shrink-0 place-items-center">
            <StatusIcon status={a.status} />
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-fg">{roleOf(a)}</span>
          <span className="min-w-0 flex-1 truncate text-fg-3">{a.title}</span>
          <time dateTime={a.created_at} className="shrink-0 text-xs text-fg-3 tabular-nums">
            {formatRelative(a.created_at, now)}
          </time>
        </button>
      ))}
      {agents.length > PAGE && <MoreRow slot label={all ? "Show fewer" : `Show all (${agents.length})`} expanded={all} onClick={() => setAll((x) => !x)} />}
    </InfoSection>
  );
}

function FilesWritten() {
  const writes = useWrittenFiles();
  const code = useCode();
  const now = useNow(true, 60_000);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => (writes ? groupWrites(writes, now) : null), [writes, now]);
  const slow = useDelayedLoading(writes === null);
  return (
    <InfoSection title="Files written" labelId="details-files">
      {groups === null && (
        <div className={cn(!slow && "opacity-0")}>
          <SkeletonRows count={3} />
        </div>
      )}
      {groups?.length === 0 && <p className={cn(INFO_ROW, "text-fg-3")}>No files written yet.</p>}
      {groups?.map((g) => {
        const shown = open[g.label] ? g.files : g.files.slice(0, PAGE);
        return (
          <div key={g.label} role="group" aria-label={g.label} className="flex flex-col">
            <div className="flex h-row items-center px-2 text-xs text-fg-3">
              <span aria-hidden className="mr-2 size-4 shrink-0" />
              {g.label}
            </div>
            {shown.map((f) => {
              const dir = parentPath(f.path);
              return (
                <button key={`${f.folder}/${f.path}`} type="button" title={`${f.folder}/${f.path}`} onClick={() => code.openFile(f.folder, f.path)} className={INFO_ROW_BUTTON}>
                  <Glyph icon={fileIcon(f.path)} size={14} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 shrink truncate text-fg">{fileName(f.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
                    <bdi>{dir ? `${f.folder}/${dir}` : f.folder}</bdi>
                  </span>
                  {f.count > 1 && (
                    <span className="shrink-0 text-xs text-fg-3 tabular-nums" aria-label={`written ${f.count} times`}>
                      ×{f.count}
                    </span>
                  )}
                </button>
              );
            })}
            {g.files.length > PAGE && (
              <MoreRow slot label={open[g.label] ? "Show fewer" : `Show ${g.files.length - PAGE} more`} expanded={Boolean(open[g.label])} onClick={() => setOpen((o) => ({ ...o, [g.label]: !o[g.label] }))} />
            )}
          </div>
        );
      })}
    </InfoSection>
  );
}
