import type { Agent, LanguageServerInfo, PluginAgent } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
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
import { StatusIcon } from "../primitives/Status";
import { groupWrites, useWrittenFiles } from "./useWrittenFiles";
import { Server, type LucideIcon } from "lucide-react";
import { languagesIn } from "../../lib/languages";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import type { ContextBreakdown } from "@octo/agent-client";
import { contextMeter, shareText } from "../../lib/contextMeter";
import { budgetState, policyLabel, routeLine } from "../../lib/models";
import { useModelNames } from "../../state/models";

/** Rows shown before "Show all" / "Show more" (contract v6 decision 17). */
const PAGE = 8;
/** Outputs of the latest request shown before "Show more" (decision 38). */
const OUTPUTS = 5;
const TIERS = [
  ["orchestrator", "Orchestrator"],
  ["fast", "Fast"],
  ["balanced", "Balanced"],
  ["deep", "Deep"],
] as const;

const roleOf = (a: Agent) => (a.parent_id === null ? "Orchestrator" : roleText(a.role));

/**
 * The Details tab as stacked sections (decision 38): one scroll of plain sections, each a 12px caption and 28px rows,
 * 20px apart, at most one quiet text action at a caption's right — Project (folders), Context (the orchestrator's
 * window: "N% used", one 3px bar split by part, a legend), Team (models per tier, routing, budget), Outputs (files this
 * request wrote; "All" for every file), Plugins in use, Activity. Tokens per agent live in Usage. Real data only.
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
      <div ref={rows} className="mx-auto flex w-full max-w-details flex-col gap-5">
        <Folders />
        <Context />
        <Team />
        <Outputs />
        <PluginsInUse />
        <Activity />
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
    <InfoSection title="Project" labelId="details-folders">
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

/** The orchestrator's context (decision 38): `GET …/context`, read when the tab opens and after each turn. */
function useContextBreakdown(): { status: "loading" | "error" | "ok"; value: ContextBreakdown | null; retry(): void } {
  const { bridge } = useApp();
  const { projectId, project, state } = useProject();
  const root = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const stamp = `${root?.finished_at ?? ""}:${root?.status ?? ""}:${(project && state.compactions[project.orchestrator_agent_id]?.length) ?? 0}`;
  const [load, setLoad] = useState<{ status: "loading" | "error" | "ok"; value: ContextBreakdown | null }>({ status: "loading", value: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    bridge.getContext(projectId).then(
      (value) => alive && setLoad({ status: "ok", value }),
      () => alive && setLoad((l) => ({ status: l.value ? "ok" : "error", value: l.value })),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, stamp, attempt]);
  return { ...load, retry: () => setAttempt((n) => n + 1) };
}

function Context() {
  const ctx = useContextBreakdown();
  const slow = useDelayedLoading(ctx.status === "loading");
  const meter = ctx.value ? contextMeter(ctx.value) : null;
  return (
    <InfoSection
      title="Context"
      labelId="details-context"
      aside={
        meter?.estimated && (
          <span className="shrink-0" title="Counted from the stored text (about 4 characters a token), not reported by the model">
            estimated
          </span>
        )
      }
    >
      {ctx.status === "loading" && (
        <div className={cn(!slow && "opacity-0")}>
          <SkeletonRows count={2} />
        </div>
      )}
      {ctx.status === "error" && (
        <p className={cn(INFO_ROW, "text-fg-3")}>
          Couldn't read the context.
          <button type="button" onClick={ctx.retry} className="ml-auto text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
            Try again
          </button>
        </p>
      )}
      {meter && (
        <>
          <div className={INFO_ROW}>
            <span className="text-fg">{meter.percent ?? "Window unknown"}</span>
            <span className="ml-auto shrink-0 font-mono text-xs text-fg-2 tabular-nums">{meter.amount}</span>
          </div>
          {/* One 3px bar: the window's used share, split by part (decision 38). */}
          <div
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meter.fill * 100)}
            className="mx-2 mb-1 flex h-[3px] overflow-hidden rounded-full bg-line"
          >
            {meter.rows.map((r) => (
              <span key={r.key} className={`octo-ctx-${r.key} h-full`} style={{ width: `${(meter.fill > 0 ? meter.fill : 1) * r.share * 100}%` }} />
            ))}
          </div>
          {meter.rows.map((r) => (
            <div key={r.key} data-context-part={r.key} className={INFO_ROW}>
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                <span className={`octo-ctx-${r.key} size-2 rounded-2xs`} />
              </span>
              <span className="min-w-0 truncate text-fg-2">{r.label}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-fg-2 tabular-nums">{formatTokens(r.tokens)}</span>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-fg-3 tabular-nums">{shareText(r.share)}</span>
            </div>
          ))}
        </>
      )}
    </InfoSection>
  );
}

function Team() {
  const { project, state } = useProject();
  const { config } = useApp();
  const names = useModelNames();
  if (!project) return null;
  const root = state.agents[project.orchestrator_agent_id];
  const budget = budgetState(project.spent_usd, project.budget_usd);
  // The latest delegation the router placed (tier `auto`): its decision as one quiet line (live test).
  const routed = state.agentOrder
    .map((id) => state.agents[id])
    .filter((a): a is Agent => a !== undefined && Boolean(a.route_choice))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const route = routed ? routeLine(routed, config?.acp_orchestrators ?? []) : null;
  return (
    <InfoSection title="Team" labelId="details-models">
      {TIERS.map(([key, label]) => {
        // The orchestrator's row names the model that answered (decision 37), and under it the one it asked for.
        const served =
          key === "orchestrator" && root?.served_model ? names.served({ model: project.models.orchestrator, served_model: root.served_model }) : null;
        return (
          <div key={key} className="flex flex-col">
            <div className={INFO_ROW} title={served ? served.long : project.models[key]}>
              <span className="shrink-0 text-fg-2">{label}</span>
              <span className="ml-auto min-w-0 truncate pl-2 text-fg">{served ? served.name : names.name(project.models[key])}</span>
            </div>
            {served?.asked && <p className="-mt-1 truncate px-2 pb-1 text-right text-xs text-fg-3">asked for {served.asked}</p>}
          </div>
        );
      })}
      {config?.router && (
        <div className={INFO_ROW}>
          <span className="shrink-0 text-fg-2">Routing</span>
          <span className="ml-auto text-fg">{policyLabel(project.models.tier_policy)}</span>
        </div>
      )}
      {route && (
        <p data-route-line className="truncate px-2 pt-1 text-xs text-fg-3" title={route}>
          {route}
        </p>
      )}
      {budget && (
        <div className={INFO_ROW} title={budget.reached ? "Project budget reached. Raise it in project settings to continue." : undefined}>
          <span className="shrink-0 text-fg-2">Budget</span>
          <span className={cn("ml-auto font-mono text-xs tabular-nums", budget.tone === "err" ? "text-err" : budget.tone === "warn" ? "text-warn" : "text-fg")}>
            {budget.text}
          </span>
        </div>
      )}
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

/**
 * Outputs (decision 38): the files the latest request wrote, newest first, 5 then "Show more"; "All files" at the caption's
 * right switches to every file written, grouped Today / This week / Earlier. When a command ran in that request, a note
 * says the list may be incomplete (changes made by commands are not tracked yet).
 */
function Outputs() {
  const writes = useWrittenFiles();
  const code = useCode();
  const { project, state } = useProject();
  const now = useNow(true, CLOCK_MINUTE_MS);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const root = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const since = root?.started_at ? Date.parse(root.started_at) : null;
  const latest = useMemo(() => {
    if (!writes || since === null) return [];
    return groupWrites(
      writes.files.filter((w) => Date.parse(w.at) >= since),
      now,
    ).flatMap((g) => g.files);
  }, [writes, since, now]);
  const commandsRan = writes !== null && since !== null && writes.commands.some((t) => Date.parse(t) >= since);
  const groups = useMemo(() => (writes ? groupWrites(writes.files, now) : null), [writes, now]);
  const slow = useDelayedLoading(writes === null);
  const row = (f: { folder: string; path: string; count: number }) => {
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
  };
  const toggle = groups && groups.length > 0 && (
    <button
      type="button"
      aria-pressed={all}
      onClick={() => setAll((x) => !x)}
      className="-mr-1 h-chip shrink-0 rounded-sm px-1 text-xs text-fg-3 hover:bg-hover hover:text-fg"
    >
      {all ? "This request" : "All files"}
    </button>
  );
  return (
    <InfoSection title={all ? "Files written" : "Outputs"} labelId="details-files" aside={toggle}>
      {groups === null && (
        <div className={cn(!slow && "opacity-0")}>
          <SkeletonRows count={3} />
        </div>
      )}
      {!all && writes !== null && (
        <>
          {latest.length === 0 && (
            <p className={cn(INFO_ROW, "text-fg-3")}>{since === null ? "No requests yet." : "No files written in the latest request."}</p>
          )}
          {(more ? latest : latest.slice(0, OUTPUTS)).map(row)}
          {latest.length > OUTPUTS && (
            <MoreRow slot label={more ? "Show fewer" : `Show ${latest.length - OUTPUTS} more`} expanded={more} onClick={() => setMore((x) => !x)} />
          )}
          {commandsRan && (
            <p data-outputs-note className="px-2 pt-1 text-xs text-fg-3">
              Commands ran in this request; files they changed are not tracked yet, so this list may be incomplete.
            </p>
          )}
        </>
      )}
      {all && groups?.length === 0 && <p className={cn(INFO_ROW, "text-fg-3")}>No files written yet.</p>}
      {all &&
        groups?.map((g) => {
          const shown = open[g.label] ? g.files : g.files.slice(0, PAGE);
          return (
            <div key={g.label} role="group" aria-label={g.label} className="flex flex-col">
              <div className="flex h-row items-center px-2 text-xs text-fg-3">
                <span aria-hidden className="mr-2 size-4 shrink-0" />
                {g.label}
              </div>
              {shown.map(row)}
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
