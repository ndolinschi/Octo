import { SETTING_IDS, type AutoMemoryMode, type Limit, type Project, type ProjectInput } from "@octo/agent-client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useDelayedLoading } from "../../lib/hooksMore";
import { modelName } from "../../lib/models";
import { canRun, useProviders } from "../../lib/providers";
import { remainingText } from "../../lib/usage";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Notice } from "../primitives/Notice";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { TextField } from "../primitives/TextField";
import { settingsHref } from "../../lib/route";
import { useHarnessSettings } from "./harnessSettings";
import { limitTitle, resetsIn, spendText } from "./usageText";
import { CONTROL_W, LoadErrorRow, SaveStatus, SELECT_W, SettingsGroup, SettingsRow } from "./parts";
import { ScopeRow, useProjectScope } from "./scope";
import { useProjectDetails, type ProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";
import { UsageByProject } from "./UsageByProject";

type Update = (id: string, patch: Partial<ProjectInput>) => Promise<void>;

/**
 * B10: a per-project section is one scope menu ("Settings for", the same control in Models, Commands, Editor, Memory and
 * Budget) and the chosen project's rows; loading, error and "no projects" are handled once here.
 */
function PerProject(props: {
  label: string;
  rowId: string;
  details: ProjectDetails;
  retry(): void;
  openProject: string | null;
  scopeText: string;
  footer?: string;
  row(p: Project): ReactNode;
}) {
  const { details } = props;
  const projects = details.status === "ready" ? details.projects : [];
  const { sorted, project, choose } = useProjectScope(projects, props.openProject);
  return (
    <>
      {project && <ScopeRow projects={sorted} value={project.id} onChange={choose} description={props.scopeText} />}
      <SettingsGroup
        label={props.label}
        id={`row-${props.rowId}`}
        footer={details.status === "ready" && details.more > 0 ? `${props.footer ?? ""} ${details.more} older projects are not listed.`.trim() : props.footer}
      >
        {details.status === "loading" && <SkeletonList count={1} size="lg" twoLine />}
        {details.status === "error" && (
          <LoadErrorRow what="projects" message={details.message} hint="Check that Octo's local service is running, then retry." onRetry={props.retry} />
        )}
        {details.status === "ready" && !project && <SettingsRow title="No projects yet" description="Each project you create can be set here." />}
        {project && props.row(project)}
      </SettingsGroup>
    </>
  );
}

function ProjectSelect<T extends string>(props: {
  rowId?: string;
  project: Project;
  value: T;
  options: readonly { id: T; label: string }[];
  title: string;
  description: ReactNode;
  patch(v: T): Partial<ProjectInput>;
  update: Update;
}) {
  const [saved, run] = useSave();
  const id = useId();
  return (
    <SettingsRow
      {...(props.rowId ? { rowId: props.rowId } : {})}
      title={props.title}
      htmlFor={id}
      description={props.description}
      status={<SaveStatus state={saved} />}
      control={
        <div className={SELECT_W}>
          <Select
            size="sm"
            id={id}
            label={`${props.title} for ${props.project.name}`}
            value={props.value}
            options={props.options.map((o) => ({ value: o.id, label: o.label }))}
            onChange={(value) => {
              const v = props.options.find((o) => o.id === value)?.id;
              if (v !== undefined) void run(() => props.update(props.project.id, props.patch(v)));
            }}
          />
        </div>
      }
    />
  );
}

const COMPLETION = [
  { id: "off", label: "Off" },
  { id: "small", label: "Small tier (Ollama)" },
] as const;

const isOllamaCompletion = (v: string) => v === "small" || v.startsWith("ollama:");

export function EditorSection({ projectId }: { projectId: string | null }) {
  const { details, update, retry } = useProjectDetails();
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const harness = useHarnessSettings();
  const list = providers.status === "ready" ? providers.list : null;
  const ollama = list?.providers.find((p) => p.kind === "ollama");
  const modelSetting = harness.get(SETTING_IDS.modelCompletion);
  const configuredSmall = (typeof modelSetting?.value === "string" && modelSetting.value.trim()) || ollama?.default_model || "qwen2.5-coder:1.5b";
  return (
    <>
      <PerProject
        label="Inline completion"
        rowId="completion"
        details={details}
        retry={retry}
        openProject={projectId}
        scopeText="Inline completion is set per project."
        footer="Suggests code as you type in the editor. Uses Ollama's dedicated small tier; coding agents and higher chat tiers are not used."
        row={(p) => {
          const value = p.models.completion ?? "off";
          const known = COMPLETION.some((o) => o.id === value);
          const ollamaMode = isOllamaCompletion(value);
          const smallModel = value.startsWith("ollama:") ? value.slice("ollama:".length).trim() || configuredSmall : configuredSmall;
          // A3: a value that cannot run is said the same way as everywhere else (the warn tone and a reason).
          const stuck = value !== "off" && list !== null && !canRun(list, value);
          return (
            <ProjectSelect
              key={p.id}
              project={p}
              value={value}
              options={known ? COMPLETION : [...COMPLETION, { id: value, label: modelName(value) }]}
              title="Suggestions"
              description={
                value === "off" ? (
                  "No suggestions."
                ) : ollamaMode ? (
                  stuck ? (
                    <Notice tone="warn">Cannot run: check the Ollama server URL and model below.</Notice>
                  ) : (
                    `Runs through Ollama's dedicated small tier (${smallModel}).`
                  )
                ) : stuck ? (
                  <Notice
                    tone="warn"
                    action={
                      <a href={settingsHref("providers")} className="text-link underline-offset-2 hover:underline">
                        Add a key
                      </a>
                    }
                  >
                    Cannot run: it needs an Anthropic API key or the Octo router.
                  </Notice>
                ) : (
                  "Suggestions on."
                )
              }
              patch={(v) => ({ models: { completion: v } })}
              update={update}
            />
          );
        }}
      />
      <SettingsGroup label="Ollama small tier" footer="Local Ollama model and endpoint used when inline completion is set to Small tier (Ollama).">
        {harness.load.status === "unavailable" && <SettingsRow title="Not available here" description="This window can't read or change Octo's settings." />}
        {harness.load.status === "loading" && <SkeletonList count={2} size="lg" twoLine />}
        {harness.load.status === "error" && (
          <LoadErrorRow what="settings" message={harness.load.message} hint="Octo's local service answers only on this computer." onRetry={harness.reload} />
        )}
        {harness.load.status === "ready" && (
          <>
            <HarnessTextRow
              settingId={SETTING_IDS.modelCompletion}
              rowId="completion-model"
              title="Ollama small-tier model"
              description="Ollama model tag used for inline completions."
              placeholder="qwen2.5-coder:1.5b"
              widthClass={CONTROL_W.md}
            />
            <HarnessTextRow
              settingId={SETTING_IDS.ollamaBaseUrl}
              rowId="ollama-url"
              title="Ollama server URL"
              description="Leave empty to use http://127.0.0.1:11434."
              placeholder="http://127.0.0.1:11434"
              widthClass={CONTROL_W.lg}
            />
          </>
        )}
      </SettingsGroup>
      {/* B9: plugins have their own section; Editor keeps a way there (the palette's "Open integrations" lands here). */}
      <SettingsGroup label="Language help">
        <SettingsRow
          title="Integrations"
          description="Language help, agents and extra tools from plugins have their own section."
          control={
            <Button size="sm" onClick={() => (window.location.hash = settingsHref("integrations"))}>
              Open Integrations
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}

function HarnessTextRow({
  settingId,
  rowId,
  title,
  description,
  placeholder,
  widthClass,
}: {
  settingId: string;
  rowId: string;
  title: string;
  description: string;
  placeholder: string;
  widthClass: string;
}) {
  const harness = useHarnessSettings();
  const [saved, run] = useSave();
  const id = useId();
  const s = harness.get(settingId);
  const stored = typeof s?.value === "string" ? s.value : "";
  const [draft, setDraft] = useState<string | null>(null);
  if (!s) return null;
  const value = draft ?? stored;
  const commit = () => {
    if (draft === null || draft.trim() === stored) return setDraft(null);
    void run(() => harness.save({ set: { [s.id]: draft.trim() } })).then((ok) => ok && setDraft(null));
  };
  return (
    <SettingsRow
      rowId={rowId}
      title={title}
      htmlFor={id}
      description={s.editable ? description : (s.note ?? `Set by the ${s.source}.`)}
      status={<SaveStatus state={saved} />}
      control={
        <div className={widthClass}>
          <TextField
            size="sm"
            id={id}
            value={value}
            disabled={!s.editable}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape" && draft !== null) {
                e.preventDefault();
                setDraft(null);
              }
            }}
            className="font-mono"
          />
        </div>
      }
    />
  );
}

const CONTEXT = [
  { id: "full", label: "Full history" },
  { id: "window", label: "Recent window" },
] as const;

const AUTO_MEMORY: readonly { id: AutoMemoryMode; label: string }[] = [
  { id: "off", label: "Off (ask first)" },
  { id: "review", label: "Review each item" },
  { id: "allow", label: "Allow automatically" },
  { id: "blocked", label: "Blocked for this project" },
];

function autoMemoryDescription(mode: AutoMemoryMode): string {
  switch (mode) {
    case "allow":
      return "Saves remembered facts and updates end-of-turn digests without asking.";
    case "review":
      return "Asks you to save or skip each item before it enters memory.";
    case "blocked":
      return "Memory is disabled for this project and hidden from the sidebar '+' and workspace menus.";
    default:
      return "Memory is off by default; asks to enable with Allow, Review, or Block when the model wants to remember something.";
  }
}

export function MemorySection({ projectId }: { projectId: string | null }) {
  const { details, update, retry } = useProjectDetails();
  return (
    <PerProject
      label="Memory"
      rowId="memory"
      details={details}
      retry={retry}
      openProject={projectId}
      scopeText="Set per project."
      footer="Full history sends the whole conversation; Recent window builds the context from memory, tasks and the last exchanges."
      row={(p) => {
        const m = { context: "full" as const, recent_exchanges: 5, auto_memory: "off" as const, ...p.memory };
        const autoMode: AutoMemoryMode = m.auto_memory ?? "off";
        return (
          <>
            <ProjectSelect
              key={`${p.id}:auto`}
              rowId="auto-memory"
              project={p}
              value={autoMode}
              options={AUTO_MEMORY}
              title="Auto-memory"
              description={autoMemoryDescription(autoMode)}
              patch={(v) => ({ memory: { auto_memory: v } })}
              update={update}
            />
            <ProjectSelect
              key={`${p.id}:context`}
              rowId="context"
              project={p}
              value={m.context}
              options={CONTEXT}
              title="Context mode"
              description={m.context === "window" ? `The last ${m.recent_exchanges} exchanges, plus memory.` : "Every message, summarised when it gets long."}
              patch={(v) => ({ memory: { context: v } })}
              update={update}
            />
          </>
        );
      }}
    />
  );
}

/** All-time cost per project from the usage report: what the budget row says when the project carries no spend figure. */
function useAllTimeCost(): Record<string, number | null> {
  const { bridge } = useApp();
  const [cost, setCost] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let live = true;
    bridge.getUsage({ from: "2000-01-01", group: "project" }).then(
      (r) => live && setCost(Object.fromEntries(r.buckets.map((b) => [b.key, b.cost_usd]))),
      () => {
        // The row then says the spend is not known; the usage table above shows its own error.
      },
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  return cost;
}

export function UsageSection({ projectId }: { projectId: string | null }) {
  const { details, update, retry } = useProjectDetails();
  const cost = useAllTimeCost();
  // Re-test 4 (CLS 0.30 at 640px): the table's rows, the limits and the budget arrive at different times. Everything under
  // the table waits (mounted, hidden) until all three have answered, then appears at once, so nothing on screen moves;
  // a slow load shows a placeholder at the bottom, which nothing follows.
  const [usageSettled, setUsageSettled] = useState(false);
  const [limitsSettled, setLimitsSettled] = useState(false);
  const below = usageSettled && limitsSettled && details.status !== "loading";
  const slow = useDelayedLoading(!below);
  return (
    <>
      <UsageByProject holdFooter={!below} onSettled={setUsageSettled} />
      {!below && slow && usageSettled && <SkeletonList count={2} size="lg" twoLine />}
      {/* B (b): the table and the row groups take the same column, so Usage has one left and one right edge. */}
      <div hidden={!below} className="flex flex-col gap-6">
        <Limits onSettled={setLimitsSettled} />
        <PerProject
          label="Budget"
          rowId="budget"
          details={details}
          retry={retry}
          openProject={projectId}
          scopeText="A budget is set per project."
          // B11: what the harness does (apps/harness/docs/architecture.md, Budget): the cap is on everything the project has
          // ever spent, not per month; subscription use is not spend.
          footer="A budget caps a project's total spending (not per month). It is checked between steps, so a step already running can go over. Subscription use is not counted."
          row={(p) => <BudgetRow key={p.id} project={p} update={update} usage={cost[p.id]} />}
        />
      </div>
    </>
  );
}

function BudgetRow({ project: p, update, usage }: { project: Project; update: Update; usage: number | null | undefined }) {
  const [saved, run, clear] = useSave();
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const stored = p.budget_usd != null ? String(p.budget_usd) : "";
  const value = draft ?? stored;
  const parsed = Number(value);
  const invalid = value.trim() !== "" && (!Number.isFinite(parsed) || parsed <= 0);
  const commit = () => {
    if (draft === null || draft.trim() === stored || invalid) return;
    void run(() => update(p.id, { budget_usd: draft.trim() === "" ? null : parsed })).then((ok) => ok && setDraft(null));
  };
  return (
    <SettingsRow
      title="Budget"
      htmlFor={id}
      description={invalid ? <Notice tone="error">A positive amount in USD, or empty for no budget.</Notice> : spendText(p.spent_usd, usage, stored)}
      status={<SaveStatus state={saved} />}
      control={
        <TextField
          size="sm"
          id={id}
          inputMode="decimal"
          value={value}
          leading="$"
          placeholder="No budget"
          aria-label={`Budget for ${p.name}, in USD`}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            // B11: an edit takes back the last "Saved", so it never sits beside a new validation error.
            clear();
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className={`${CONTROL_W.sm} tabular-nums`}
        />
      }
    />
  );
}

type LimitsLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; limits: Limit[] };

function Limits({ onSettled }: { onSettled(settled: boolean): void }) {
  const { bridge } = useApp();
  const [load, setLoad] = useState<LimitsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const now = useNow(true, CLOCK_MINUTE_MS);
  useEffect(() => {
    let live = true;
    bridge.getLimits().then(
      (limits) => {
        if (!live) return;
        setLoad({ status: "ready", limits });
        onSettled(true);
      },
      (e: unknown) => {
        if (!live) return;
        setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") });
        onSettled(true);
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, attempt, onSettled]);
  return (
    <SettingsGroup label="Subscription limits" id="row-limits">
      {load.status === "loading" && <SkeletonList count={1} size="lg" twoLine />}
      {load.status === "error" && (
        <LoadErrorRow
          what="limits"
          message={load.message}
          hint="Retry once Octo's local service is running."
          onRetry={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {load.status === "ready" && load.limits.length === 0 && (
        <SettingsRow title="No limits reported yet" description="Limits appear after the first model answer that reports them." />
      )}
      {load.status === "ready" &&
        load.limits.map((l) => (
          <SettingsRow
            key={`${l.provider}/${l.model}/${l.kind}/${l.resets_at ?? ""}`}
            title={<span title={`${l.provider} · ${l.model}`}>{limitTitle(l)}</span>}
            // C20: relative, the exact time in the tooltip.
            description={
              <span title={l.resets_at ? new Date(l.resets_at).toLocaleString() : undefined}>{`${resetsIn(l.resets_at, now)} · ${modelName(l.model)}`}</span>
            }
            // S6: compact numbers ("1.7M of 2M left"), the full values in the tooltip.
            control={
              <span
                className="text-sm text-fg-2 tabular-nums"
                title={`${l.remaining?.toLocaleString("en-US") ?? "?"} of ${l.limit?.toLocaleString("en-US") ?? "?"} left`}
              >
                {remainingText(l)}
              </span>
            }
          />
        ))}
    </SettingsGroup>
  );
}
