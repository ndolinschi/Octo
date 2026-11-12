import type { Limit, Project, ProjectInput } from "@octo/agent-client";
import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { Notice } from "../primitives/Notice";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { TextField } from "../primitives/TextField";
import { CONTROL_W, LoadErrorRow, SaveStatus, SettingsGroup, SettingsRow } from "./parts";
import { useProjectDetails, type ProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";
import { UsageByProject } from "./UsageByProject";

const IntegrationsView = lazy(() => import("./IntegrationsView").then((m) => ({ default: m.IntegrationsView })));

/** Rows of one setting per project: loading, error, empty and "N more" handled once for Editor, Usage and Memory. */
function PerProject(props: { label: string; rowId: string; details: ProjectDetails; retry(): void; footer?: string; row(p: Project): ReactNode }) {
  const { details } = props;
  return (
    <SettingsGroup
      label={props.label}
      id={`row-${props.rowId}`}
      footer={details.status === "ready" && details.more > 0 ? `${details.more} more in each project's own settings.` : props.footer}
    >
      {details.status === "loading" && <SkeletonList count={2} size="lg" twoLine />}
      {details.status === "error" && (
        <LoadErrorRow what="projects" message={details.message} hint="Check that the harness is running, then retry." onRetry={props.retry} />
      )}
      {details.status === "ready" && details.projects.length === 0 && (
        <SettingsRow title="No projects yet" description="Each project you create gets its own row here." />
      )}
      {details.status === "ready" && details.projects.map((p) => props.row(p))}
    </SettingsGroup>
  );
}

function ProjectSelect<T extends string>(props: {
  project: Project;
  value: T;
  options: readonly { id: T; label: string }[];
  /** What the control sets, for its accessible name. */
  title: string;
  description: string;
  patch(v: T): Partial<ProjectInput>;
  update(id: string, patch: Partial<ProjectInput>): Promise<void>;
}) {
  const [saved, run] = useSave();
  const id = useId();
  return (
    <SettingsRow
      title={props.project.name}
      htmlFor={id}
      description={props.description}
      status={<SaveStatus state={saved} />}
      control={
        <Select
          id={id}
          label={`${props.project.name}: ${props.title}`}
          value={props.value}
          options={props.options.map((o) => ({ value: o.id, label: o.label }))}
          onChange={(value) => {
            const v = props.options.find((o) => o.id === value)?.id;
            if (v !== undefined) void run(() => props.update(props.project.id, props.patch(v)));
          }}
          className={CONTROL_W.md}
        />
      }
    />
  );
}

const COMPLETION = [
  { id: "off", label: "Off" },
  { id: "fast", label: "Fast tier" },
  { id: "balanced", label: "Balanced tier" },
  { id: "deep", label: "Deep tier" },
] as const;

export function EditorSection() {
  const { details, update, retry } = useProjectDetails();
  return (
    <>
      <PerProject
        label="Inline completion"
        rowId="completion"
        details={details}
        retry={retry}
        footer="Suggests code as you type in the editor. Uses the API (never an agent)."
        row={(p) => {
          const value = p.models.completion ?? "off";
          const known = COMPLETION.some((o) => o.id === value);
          return (
            <ProjectSelect
              key={p.id}
              project={p}
              value={value}
              options={known ? COMPLETION : [...COMPLETION, { id: value, label: value }]}
              title="Inline completion"
              description={value === "off" ? "No suggestions." : "Suggestions on."}
              patch={(v) => ({ models: { completion: v } })}
              update={update}
            />
          );
        }}
      />
      <SettingsGroup label="Plugins and language servers" id="row-plugins">
        <div className="p-4">
          <Suspense fallback={<p className="h-9" aria-busy />}>
            <IntegrationsView />
          </Suspense>
        </div>
      </SettingsGroup>
    </>
  );
}

const CONTEXT = [
  { id: "full", label: "Full history" },
  { id: "window", label: "Recent window" },
] as const;

export function MemorySection() {
  const { details, update, retry } = useProjectDetails();
  return (
    <PerProject
      label="Context mode"
      rowId="context"
      details={details}
      retry={retry}
      footer="Full history sends the whole conversation; Recent window builds the context from memory, tasks and the last exchanges."
      row={(p) => {
        const m = p.memory ?? { context: "full", recent_exchanges: 5 };
        return (
          <ProjectSelect
            key={p.id}
            project={p}
            value={m.context}
            options={CONTEXT}
            title="Context mode"
            description={m.context === "window" ? `The last ${m.recent_exchanges} exchanges, plus memory.` : "Every message, summarised when it gets long."}
            patch={(v) => ({ memory: { context: v } })}
            update={update}
          />
        );
      }}
    />
  );
}

export function UsageSection() {
  const { details, update, retry } = useProjectDetails();
  return (
    <>
      <UsageByProject />
      <Limits />
      <PerProject
        label="Budget"
        rowId="budget"
        details={details}
        retry={retry}
        footer="A project stops starting new work once it has spent its budget."
        row={(p) => <BudgetRow key={p.id} project={p} update={update} />}
      />
    </>
  );
}

function BudgetRow({ project: p, update }: { project: Project; update(id: string, patch: Partial<ProjectInput>): Promise<void> }) {
  const [saved, run] = useSave();
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
  const spent = p.spent_usd != null ? `$${p.spent_usd.toFixed(2)} spent` : "Spend not known yet";
  return (
    <SettingsRow
      title={p.name}
      htmlFor={id}
      description={
        invalid ? <Notice tone="error">A positive amount in USD, or empty for no budget.</Notice> : `${spent}. ${stored ? `Budget $${stored}.` : "No budget."}`
      }
      status={<SaveStatus state={saved} />}
      control={
        <TextField
          id={id}
          inputMode="decimal"
          value={value}
          placeholder="No budget"
          aria-invalid={invalid || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className={`${CONTROL_W.sm} text-right tabular-nums max-settings:text-left`}
        />
      }
    />
  );
}

type LimitsLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; limits: Limit[] };

function Limits() {
  const { bridge } = useApp();
  const [load, setLoad] = useState<LimitsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    bridge.getLimits().then(
      (limits) => live && setLoad({ status: "ready", limits }),
      (e: unknown) => live && setLoad({ status: "error", message: errorMessage(e).replace(/\.$/, "") }),
    );
    return () => {
      live = false;
    };
  }, [bridge, attempt]);
  return (
    <SettingsGroup label="Plan limits" id="row-limits">
      {load.status === "loading" && <SkeletonList count={1} size="lg" twoLine />}
      {load.status === "error" && (
        <LoadErrorRow
          what="limits"
          message={load.message}
          hint="Retry once the harness is running."
          onRetry={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {load.status === "ready" && load.limits.length === 0 && (
        <SettingsRow title="No limits reported yet" description="They appear after the first answer from an API that reports rate limits." />
      )}
      {load.status === "ready" &&
        load.limits.map((l) => (
          <SettingsRow
            key={`${l.provider}/${l.model}/${l.kind}`}
            title={`${l.provider} · ${l.kind.replace(/_/g, " ")}`}
            description={l.resets_at ? `Resets ${new Date(l.resets_at).toLocaleString()}` : "No reset time reported"}
            control={
              <span className="text-sm text-fg-2 tabular-nums">
                {l.remaining ?? "?"} of {l.limit ?? "?"} left
              </span>
            }
          />
        ))}
    </SettingsGroup>
  );
}
