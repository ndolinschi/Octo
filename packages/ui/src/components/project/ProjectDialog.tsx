import type { Models, Project, ProjectInput, TierPolicy } from "@octo/agent-client";
import { budgetState, modelIds, parseBudget, TIER_POLICIES } from "../../lib/models";
import { ModelPicker } from "../shared/ModelPicker";
import { Segmented } from "../primitives/Segmented";
import { ChevronRight, Plus, X } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useId, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { basename, errorMessage } from "../../lib/format";
import { useHost } from "../../state/host";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field, Input, Textarea } from "../primitives/Field";

type FolderRow = { key: number; path: string; label: string };

const MODEL_FIELDS: { key: "orchestrator" | "fast" | "balanced" | "deep"; label: string }[] = [
  { key: "orchestrator", label: "Orchestrator" },
  { key: "fast", label: "Fast tier" },
  { key: "balanced", label: "Balanced tier" },
  { key: "deep", label: "Deep tier" },
];

const FALLBACK_MODELS: Models = { orchestrator: "", fast: "", balanced: "", deep: "" };

function isAbsolute(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function ProjectDialog(props: { project?: Project; onClose(): void; onSubmit(input: ProjectInput): Promise<void>; onDelete?(): Promise<void> }) {
  const { config } = useApp();
  const { pickFolder } = useHost();
  const editing = Boolean(props.project);
  const initialModels = props.project?.models ?? config?.default_models ?? FALLBACK_MODELS;
  const [name, setName] = useState(props.project?.name ?? "");
  const [description, setDescription] = useState(props.project?.description ?? "");
  const [instructions, setInstructions] = useState(props.project?.instructions ?? "");
  const [folders, setFolders] = useState<FolderRow[]>(() => {
    const rows = props.project?.folders.map((f, i) => ({ key: i, path: f.path, label: f.label })) ?? [];
    return rows.length ? rows : [{ key: 0, path: "", label: "" }];
  });
  const [models, setModels] = useState<Models>(initialModels);
  const [maxDepth, setMaxDepth] = useState(props.project?.max_depth ?? config?.default_max_depth ?? 3);
  const [budget, setBudget] = useState(props.project?.budget_usd ? String(props.project.budget_usd) : "");
  const [policy, setPolicy] = useState<TierPolicy>(props.project?.models.tier_policy ?? "auto");
  const router = config?.router === true;
  const known = modelIds(...Object.values(initialModels), ...Object.values(config?.default_models ?? {}));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const id = useId();

  const filled = folders.filter((f) => f.path.trim());
  const badPath = filled.find((f) => !isAbsolute(f.path.trim()));
  const depthOk = Number.isInteger(maxDepth) && maxDepth >= 1 && maxDepth <= 8;
  const nameError = submitted && !name.trim() ? "Enter a project name." : null;
  const folderError = badPath ? "Use an absolute path, like /Users/you/code/repo." : null;
  const depthError = submitted && !depthOk ? "Enter a whole number from 1 to 8." : null;
  const budgetValue = parseBudget(budget);
  const budgetOk = budgetValue === null || !Number.isNaN(budgetValue);
  const budgetError = !budgetOk ? "Enter an amount in US dollars, like 25 or 12.50." : null;
  const spent = budgetState(props.project?.spent_usd, props.project?.budget_usd);

  const updateFolder = (key: number, patch: Partial<FolderRow>) => setFolders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const firstInvalid = !name.trim() ? `${id}-name` : badPath ? `${id}-folder-${badPath.key}` : !depthOk ? `${id}-depth` : !budgetOk ? `${id}-budget` : null;
    if (firstInvalid) {
      if (firstInvalid === `${id}-depth` || firstInvalid === `${id}-budget`) setAdvanced(true);
      requestAnimationFrame(() => document.getElementById(firstInvalid)?.focus());
      return;
    }
    setBusy(true);
    setError(null);
    const changedModels: Partial<Models> = Object.fromEntries(
      Object.entries(models).flatMap(([k, v]) => (k !== "tier_policy" && k !== "side" && typeof v === "string" && v.trim() ? [[k, v.trim()]] : [])),
    );
    if (router) changedModels.tier_policy = policy;
    // A budget is set or changed; an emptied field removes it (PATCH only: a new project simply has none).
    const budgetPatch = budgetValue !== null ? { budget_usd: budgetValue } : props.project?.budget_usd ? { budget_usd: null } : {};
    try {
      await props.onSubmit({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        folders: filled.map((f) => ({ path: f.path.trim(), ...(f.label.trim() ? { label: f.label.trim() } : {}) })),
        models: changedModels,
        max_depth: maxDepth,
        ...budgetPatch,
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.onDelete) return;
    setBusy(true);
    try {
      await props.onDelete();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Dialog
      title={editing ? "Project settings" : "New project"}
      {...(editing ? { description: "Changes apply from the next turn." } : {})}
      onClose={props.onClose}
      footer={
        confirmDelete ? (
          <>
            <p className="basis-full text-sm text-fg-2 max-[420px]:order-last sm:flex-1 sm:basis-0">
              Delete <span className="text-fg">{props.project?.name}</span> and its history? This can't be undone.
            </p>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy} autoFocus>
              Delete project
            </Button>
          </>
        ) : (
          <>
            {props.onDelete && (
              <Button variant="ghost" className="text-err! hover:text-err! min-[421px]:mr-auto min-[421px]:-ml-3" onClick={() => setConfirmDelete(true)}>
                Delete project
              </Button>
            )}
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={id} disabled={busy}>
              {editing ? "Save changes" : "Create project"}
            </Button>
          </>
        )
      }
    >
      <form id={id} onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="grid gap-3">
          <Field label="Name" htmlFor={`${id}-name`} error={nameError} errorId={`${id}-name-error`}>
            <Input
              id={`${id}-name`}
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Billing service"
              aria-required
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${id}-name-error` : undefined}
            />
          </Field>
          <Field label="Description" htmlFor={`${id}-desc`} optional>
            <Input id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Payments API and webhook workers" />
          </Field>
          <Field label="Instructions" htmlFor={`${id}-instr`} optional>
            <Textarea
              id={`${id}-instr`}
              rows={3}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Prefer small, reviewable changes. Never touch the migrations folder without asking."
            />
          </Field>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm text-fg-2">
            Folders <span className="text-xs text-fg-3">agents can only work inside these</span>
          </legend>
          {folders.map((f, i) => {
            const invalid = f.path.trim() !== "" && !isAbsolute(f.path.trim());
            return (
              <div key={f.key} className="flex items-center gap-2">
                <Input
                  id={`${id}-folder-${f.key}`}
                  aria-label={`Folder ${i + 1} path`}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `${id}-folder-error` : undefined}
                  value={f.path}
                  onChange={(e) => updateFolder(f.key, { path: e.target.value })}
                  placeholder="/Users/you/code/repo"
                  className="flex-[2] font-mono text-xs"
                />
                <Input
                  aria-label={`Folder ${i + 1} label`}
                  value={f.label}
                  onChange={(e) => updateFolder(f.key, { label: e.target.value })}
                  placeholder={f.path.trim() ? basename(f.path.trim()) : "label"}
                  className="flex-1"
                />
                {pickFolder && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Browse for folder ${i + 1}`}
                    onClick={() => void pickFolder().then((path) => path && updateFolder(f.key, { path }))}
                  >
                    Browse
                  </Button>
                )}
                <IconButton
                  icon={X}
                  label={`Remove folder ${i + 1}`}
                  onClick={() => setFolders((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== f.key) : [{ key: f.key + 1, path: "", label: "" }]))}
                />
              </div>
            );
          })}
          {folderError && (
            <p id={`${id}-folder-error`} className="text-xs text-err">
              {folderError}
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="-ml-3 w-fit"
            onClick={() => setFolders((rows) => [...rows, { key: Math.max(...rows.map((r) => r.key)) + 1, path: "", label: "" }])}
          >
            Add folder
          </Button>
        </fieldset>

        <div>
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
            className="-ml-2 inline-flex h-7 items-center gap-1 rounded-sm px-2 text-sm text-fg-2 hover:bg-hover hover:text-fg"
          >
            Models and delegation
            <Glyph icon={ChevronRight} size={14} className={cn("text-fg-3", advanced && "rotate-90")} />
          </button>
          {advanced && (
            <div className="mt-3 grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {MODEL_FIELDS.map((m) => (
                  // Decision 27 / ACP in the UI: a model, a tier's model or an ACP agent on a subscription; any other id by typing it.
                  <Field key={m.key} label={m.label}>
                    <ModelPicker
                      variant="field"
                      custom
                      label={`${m.label} model`}
                      value={models[m.key]}
                      known={known}
                      {...(m.key === "orchestrator" ? { tiers: { fast: models.fast, balanced: models.balanced, deep: models.deep } } : {})}
                      onChoose={(v) => setModels((cur) => ({ ...cur, [m.key]: v }))}
                    />
                  </Field>
                ))}
              </div>
              {router && (
                <Field label="Routing" hint={TIER_POLICIES.find((p) => p.value === policy)?.detail}>
                  <Segmented<TierPolicy>
                    label="Routing policy"
                    value={policy}
                    onChange={setPolicy}
                    options={TIER_POLICIES.map((p) => ({ id: p.value, label: p.label, title: p.detail }))}
                  />
                </Field>
              )}
              <Field
                label="Budget"
                optional
                htmlFor={`${id}-budget`}
                hint={
                  spent
                    ? `Spent ${spent.text}. Leave empty for no cap.`
                    : "US dollars. The router stops the project's requests at this amount; leave empty for no cap."
                }
                error={budgetError}
                errorId={`${id}-budget-error`}
              >
                <Input
                  id={`${id}-budget`}
                  inputMode="decimal"
                  placeholder="No cap"
                  value={budget}
                  aria-invalid={budgetError ? true : undefined}
                  aria-describedby={budgetError ? `${id}-budget-error` : undefined}
                  onChange={(e) => setBudget(e.target.value)}
                  className="w-32 tabular-nums"
                />
              </Field>
              <Field
                label="Max delegation depth"
                htmlFor={`${id}-depth`}
                hint="Levels of sub-agents that may spawn their own, 1–8."
                error={depthError}
                errorId={`${id}-depth-error`}
              >
                <Input
                  id={`${id}-depth`}
                  type="number"
                  min={1}
                  max={8}
                  aria-invalid={depthError ? true : undefined}
                  aria-describedby={depthError ? `${id}-depth-error` : undefined}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                  className="w-24 tabular-nums"
                />
              </Field>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
