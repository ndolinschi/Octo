import type { Limit, Project, ProjectInput } from "@octo/agent-client";
import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Field";
import { SaveStatus, Select, SettingsGroup, SettingsRow, SkeletonRow } from "./parts";
import { useProjectDetails, type ProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";

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
      {details.status === "loading" && [0, 1].map((i) => <SkeletonRow key={i} />)}
      {details.status === "error" && (
        <SettingsRow
          title={<span className="text-err">Couldn't load projects</span>}
          description={`${details.message}. Check that the harness is running, then retry.`}
          control={
            <Button size="sm" onClick={props.retry}>
              Retry
            </Button>
          }
        />
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
          value={props.value}
          onChange={(e) => {
            const v = props.options.find((o) => o.id === e.target.value)?.id;
            if (v !== undefined) void run(() => props.update(props.project.id, props.patch(v)));
          }}
          className="w-48"
        >
          {props.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
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
        invalid ? (
          <span className="text-err">A positive amount in USD, or empty for no budget.</span>
        ) : (
          `${spent}. ${stored ? `Budget $${stored}.` : "No budget."}`
        )
      }
      status={<SaveStatus state={saved} />}
      control={
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          placeholder="No budget"
          aria-invalid={invalid || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="w-32 text-right tabular-nums max-settings:w-full max-settings:text-left max-sm:text-input-touch"
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
      {load.status === "loading" && <SkeletonRow />}
      {load.status === "error" && (
        <SettingsRow
          title={<span className="text-err">Couldn't load limits</span>}
          description={`${load.message}. Retry once the harness is running.`}
          control={
            <Button
              size="sm"
              onClick={() => {
                setLoad({ status: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          }
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
