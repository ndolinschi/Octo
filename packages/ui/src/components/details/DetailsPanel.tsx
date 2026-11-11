import type { Agent, LanguageServerInfo, PluginAgent } from "@octo/agent-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { fileName, parentPath } from "../../lib/files";
import { formatRelative, formatTokens, middleTruncate } from "../../lib/format";
import { useDelayedLoading, useNow, useRowKeys, useScrollFade } from "../../lib/hooks";
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
import { Server, type LucideIcon } from "lucide-react";
import { languagesIn } from "../../lib/languages";
import { contextText } from "../../lib/usageView";
import { CLOCK_MINUTE_MS } from "../../lib/constants";

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
  const rows = useRef<HTMLDivElement>(null);
  useRowKeys(rows);
  if (!project) return null;
  return (
    <div ref={scroller} data-details className="h-full min-h-0 overflow-y-auto overscroll-contain fade-y px-pane pt-pane pb-4">
      <div ref={rows} className="mx-auto flex w-full max-w-details flex-col gap-2">
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

/** The 16px leading slot of a row, holding a 14px glyph (every label in the panel starts on one edge). */
function Slot({ icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg-3">
      <Glyph icon={icon} size={14} />
    </span>
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
        <button key={f.id} type="button" data-row title={f.path} onClick={() => code.revealDir(f.label, "")} className={INFO_ROW_BUTTON}>
          <Slot icon={GLYPH.files} />
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

type TokenRow = {
  key: string;
  role: string;
  count: number;
  input: number;
  output: number;
  approx: boolean;
  title: string;
  /** Context occupancy an ACP agent reported (the latest agent of this role that did); never a guessed window. */
  context: { used: number; size: number } | null;
};

/** The orchestrator first, then one row per role (agents of the same role summed, with a count), by total. */
function tokenRows(agents: Agent[]): TokenRow[] {
  const rows = new Map<string, TokenRow>();
  for (const a of agents) {
    const key = a.parent_id === null ? "orchestrator" : `${isAcp(a) ? "acp:" : ""}${roleOf(a)}`;
    const row = rows.get(key) ?? { key, role: roleOf(a), count: 0, input: 0, output: 0, approx: false, title: "", context: null };
    if (typeof a.context_used === "number" && typeof a.context_size === "number" && a.context_size > 0)
      row.context = { used: a.context_used, size: a.context_size };
    row.count += 1;
    row.input += a.input_tokens;
    row.output += a.output_tokens;
    row.approx ||= isAcp(a);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      title: `${r.role}${r.count > 1 ? ` (${r.count} agents)` : ""} — ${r.input.toLocaleString()} in, ${r.output.toLocaleString()} out${r.approx ? " (approximate)" : ""}`,
    }))
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
      {shown
        .map((r) => (
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
        ))
        .flatMap((row, i) => {
          const r = shown[i];
          if (!r?.context) return [row];
          return [
            row,
            <div
              key={`${r.key}:context`}
              className={cn(INFO_ROW, "-mt-1 h-5")}
              title={`${r.role}: ${r.context.used.toLocaleString()} of ${r.context.size.toLocaleString()} tokens in its context (reported by the agent)`}
            >
              <span className="w-[40%] shrink-0 truncate pl-2 text-xs text-fg-3">{contextText(r.context.used, r.context.size)}</span>
              <span aria-hidden className="h-0.5 min-w-0 flex-1 rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(1, Math.min(100, (r.context.used / r.context.size) * 100))}%` }}
                />
              </span>
            </div>,
          ];
        })}
      {rows.length > PAGE && <MoreRow label={all ? "Show fewer" : `Show all (${rows.length})`} expanded={all} onClick={() => setAll((x) => !x)} />}
    </InfoSection>
  );
}

type PluginsLoad = { servers: LanguageServerInfo[]; agents: PluginAgent[] } | null;

/**
 * What this project can use: the available language servers for the languages its files have (from the Filter-files
 * index, loaded here) and the available ACP agents.
 */
function PluginsInUse() {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const code = useCode();
  const { indexFiles, fileIndex, loadedFiles } = code;
  useEffect(() => indexFiles(), [indexFiles]);
  const languages = useMemo(() => (fileIndex.status === "done" ? languagesIn(loadedFiles.map((f) => f.path)) : null), [fileIndex.status, loadedFiles]);
  const [load, setLoad] = useState<PluginsLoad>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([bridge.listLanguageServers(projectId), bridge.listPlugins()]).then(
      ([servers, plugins]) =>
        !cancelled && setLoad({ servers: servers.filter((s) => s.available), agents: plugins.flatMap((p) => p.agents).filter((a) => a.available) }),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId]);
  const servers = load && languages ? load.servers.filter((sv) => sv.languages.some((l) => languages.has(l))) : null;
  const slow = useDelayedLoading((load === null || languages === null) && !failed);
  const empty = load !== null && servers !== null && servers.length + load.agents.length === 0;
  return (
    <InfoSection title="Plugins in use" labelId="details-plugins">
      {failed && <p className={cn(INFO_ROW, "text-fg-3")}>Couldn't read the plugins. Reopen this tab to try again.</p>}
      {(load === null || servers === null) && !failed && (
        // The skeleton holds its room from the start and shows only once loading is slow (no jump either way).
        <div className={cn(!slow && "opacity-0")}>
          <SkeletonRows count={2} />
        </div>
      )}
      {empty && <p className={cn(INFO_ROW, "text-fg-3")}>No language servers or agents available.</p>}
      {servers?.map((s) => (
        <div key={s.id} className={INFO_ROW}>
          <Slot icon={Server} />
          <span className="min-w-0 shrink-0 truncate text-fg">{s.label}</span>
          <span className="ml-auto min-w-0 truncate pl-2 text-xs text-fg-3">{s.languages.join(", ")}</span>
        </div>
      ))}
      {servers &&
        load?.agents.map((a) => (
          <div key={a.id} className={INFO_ROW}>
            <Slot icon={GLYPH.agent} />
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
  const now = useNow(true, CLOCK_MINUTE_MS);
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
        <button
          key={a.id}
          type="button"
          data-row
          onClick={(e) => ws.openAgent(a.id, { otherSide: e.altKey })}
          title={a.title ? `${roleOf(a)}: ${a.title}` : roleOf(a)}
          className={INFO_ROW_BUTTON}
        >
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
  const now = useNow(true, CLOCK_MINUTE_MS);
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
                <button
                  key={`${f.folder}/${f.path}`}
                  type="button"
                  data-row
                  title={`${f.folder}/${f.path}`}
                  onClick={() => code.openFile(f.folder, f.path)}
                  className={INFO_ROW_BUTTON}
                >
                  <Slot icon={fileIcon(f.path)} />
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
              <MoreRow
                slot
                label={open[g.label] ? "Show fewer" : `Show ${g.files.length - PAGE} more`}
                expanded={Boolean(open[g.label])}
                onClick={() => setOpen((o) => ({ ...o, [g.label]: !o[g.label] }))}
              />
            )}
          </div>
        );
      })}
    </InfoSection>
  );
}
