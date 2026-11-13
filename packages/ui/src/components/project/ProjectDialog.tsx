import type { Models, Project, ProjectInput, TierPolicy } from "@octo/agent-client";
import { budgetState, parseBudget, TIER_POLICIES } from "../../lib/modelsMore";
import { ModelPicker } from "../shared/ModelPicker";
import { Segmented } from "../primitives/Segmented";
import { ChevronDown, ChevronRight, FolderOpen, Plus, X } from "lucide-react";
import { lazy, Suspense, useRef } from "react";
import { Presence } from "../primitives/Presence";

/** The folder picker loads with the first folder field opened (its own chunk). */
const FolderPicker = lazy(() => import("../shared/FolderPicker").then((m) => ({ default: m.FolderPicker })));
import { Glyph } from "../primitives/Glyph";
import { useId, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { folderName, labelsForFolders } from "../../lib/folderPick";
import { canRun, chipLabel, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field } from "../primitives/Field";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { TextArea, TextField } from "../primitives/TextField";
import { ApprovalRules } from "./ApprovalRules";

type FolderRow = { key: number; path: string };

const MODEL_FIELDS: { key: "orchestrator" | "fast" | "balanced" | "deep"; label: string }[] = [
  { key: "orchestrator", label: "Default model" },
  { key: "fast", label: "Fast tier" },
  { key: "balanced", label: "Balanced tier" },
  { key: "deep", label: "Deep tier" },
];

const FALLBACK_MODELS: Models = { orchestrator: "", fast: "", balanced: "", deep: "" };

function isAbsolute(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function ProjectDialog(props: { project?: Project; onClose(): void; onSubmit(input: ProjectInput): Promise<void>; onDelete?(): Promise<void> }) {
  const { config, bridge } = useApp();
  const providers = useProviders(bridge);
  const editing = Boolean(props.project);
  const initialModels = props.project?.models ?? config?.default_models ?? FALLBACK_MODELS;
  const [name, setName] = useState(props.project?.name ?? "");
  /** The name follows the first folder until the person types one (decision 71). */
  const [nameTouched, setNameTouched] = useState(editing);
  const [description, setDescription] = useState(props.project?.description ?? "");
  const [instructions, setInstructions] = useState(props.project?.instructions ?? "");
  const [folders, setFolders] = useState<FolderRow[]>(() => {
    const rows = props.project?.folders.map((f, i) => ({ key: i, path: f.path })) ?? [];
    return rows.length ? rows : [{ key: 0, path: "" }];
  });
  const [models, setModels] = useState<Models>(initialModels);
  const [maxDepth, setMaxDepth] = useState(props.project?.max_depth ?? config?.default_max_depth ?? 3);
  const [budget, setBudget] = useState(props.project?.budget_usd ? String(props.project.budget_usd) : "");
  const [policy, setPolicy] = useState<TierPolicy>(props.project?.models.tier_policy ?? "auto");
  const router = config?.router === true;
  const list = providers.status === "ready" ? providers.list : null;
  const unrunnable = list
    ? [
        ...new Set(
          MODEL_FIELDS.map((m) => models[m.key])
            .filter((v) => v !== "" && !canRun(list, v))
            .map((v) => chipLabel(v, list)),
        ),
      ]
    : [];
  const [advanced, setAdvanced] = useState(false);
  /** The folder row whose picker opens by itself ("Add folder"). */
  const [openFolderKey, setOpenFolderKey] = useState<number | null>(null);
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

  const addFolder = (path: string) => {
    const clean = path.trim().replace(/[\\/]+$/, "");
    if (!clean || folders.some((f) => f.path.trim() === clean)) return;
    setFolders((rows) => [...rows.filter((r) => r.path), { key: Math.max(-1, ...rows.map((r) => r.key)) + 1, path: clean }]);
    if (!nameTouched && filled.length === 0) setName(folderName(clean));
  };
  const removeFolder = (key: number) => setFolders((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : [{ key: key + 1, path: "" }]));
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
        // Decisions 71 and 80: no label is asked for; a folder keeps the label it has, a new one is named after itself.
        folders: labelsForFolders(
          filled.map((f) => f.path.trim()),
          props.project?.folders ?? [],
        ),
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
      <form id={id} onSubmit={submit} noValidate className="@container flex flex-col gap-5">
        <div className="grid gap-3">
          <Field label="Name" htmlFor={`${id}-name`} error={nameError} errorId={`${id}-name-error`}>
            <TextField
              id={`${id}-name`}
              data-autofocus
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              placeholder="e.g. Billing service"
              aria-required
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${id}-name-error` : undefined}
            />
          </Field>
          <Field label="Description" htmlFor={`${id}-desc`} optional>
            <TextField
              id={`${id}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Payments API and webhook workers"
            />
          </Field>
          <Field label="Instructions" htmlFor={`${id}-instr`} optional>
            <TextArea
              id={`${id}-instr`}
              rows={3}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Prefer small, reviewable changes. Never touch the migrations folder without asking."
            />
          </Field>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm text-fg-2">
            Folders <span className="text-xs text-fg-3">agents can only work inside these</span>
          </legend>
          {!editing && (
            <div className="flex flex-wrap items-center gap-1.5">
              {filled.map((f) => (
                <span key={f.key} title={f.path} className="inline-flex h-7 max-w-full items-center gap-1 rounded-sm bg-raised pl-2 text-sm text-fg">
                  <Glyph icon={FolderOpen} size={14} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 truncate">{folderName(f.path)}</span>
                  <IconButton icon={X} label={`Remove ${folderName(f.path)}`} onClick={() => removeFolder(f.key)} className="size-7" />
                </span>
              ))}
              <AddFolder
                first={filled.length === 0}
                current={filled.map((f) => f.path)}
                onChoose={(path) => {
                  addFolder(path);
                }}
              />
            </div>
          )}
          {editing &&
            folders.map((f, i) => {
              const invalid = f.path.trim() !== "" && !isAbsolute(f.path.trim());
              return (
                <div key={f.key} className="flex items-center gap-2">
                  <FolderField
                    id={`${id}-folder-${f.key}`}
                    index={i}
                    path={f.path}
                    invalid={invalid}
                    describedBy={invalid ? `${id}-folder-error` : undefined}
                    autoOpen={f.key === openFolderKey}
                    current={folders.map((x) => x.path).filter(Boolean)}
                    onChoose={(path) => updateFolder(f.key, { path })}
                  />
                  <IconButton
                    icon={X}
                    label={`Remove folder ${i + 1}`}
                    onClick={() => setFolders((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== f.key) : [{ key: f.key + 1, path: "" }]))}
                  />
                </div>
              );
            })}
          {folderError && (
            <p id={`${id}-folder-error`} className="text-xs text-err">
              {folderError}
            </p>
          )}
          {editing && (
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              className="-ml-3 w-fit"
              onClick={() =>
                setFolders((rows) => {
                  const key = Math.max(...rows.map((r) => r.key)) + 1;
                  setOpenFolderKey(key);
                  return [...rows, { key, path: "" }];
                })
              }
            >
              Add folder
            </Button>
          )}
        </fieldset>

        <div>
          <Button
            variant="quiet"
            iconEnd={advanced ? ChevronDown : ChevronRight}
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
            className="-ml-2"
          >
            Models and delegation
          </Button>
          {advanced && (
            <div className="mt-3 grid gap-3">
              {/* The same notice as Settings → Models: said once above the group, not by the tone of each value. */}
              {providers.status === "ready" && unrunnable.length > 0 && (
                <Notice tone="warn">
                  {unrunnable.join(", ")} {unrunnable.length > 1 ? "cannot run: their providers are" : "cannot run: its provider is"} not connected. Connect a
                  provider in Settings → Providers.
                </Notice>
              )}
              <div className="grid gap-3 @min-[520px]/dialog:grid-cols-2">
                {MODEL_FIELDS.map((m) => (
                  // Decision 27 / ACP in the UI: a model, a tier's model or an ACP agent on a subscription; any other id by typing it.
                  <Field key={m.key} label={m.label}>
                    <ModelPicker
                      variant="field"
                      custom
                      side="bottom"
                      label={`${m.label} model`}
                      value={models[m.key]}
                      // The notice above the group says the problem once (B52).
                      problemShown={providers.status === "ready" && unrunnable.length > 0}
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
              <FieldRow
                fields={[
                  {
                    id: `${id}-budget`,
                    label: "Budget (optional)",
                    control: (
                      <TextField
                        id={`${id}-budget`}
                        inputMode="decimal"
                        placeholder="No cap"
                        value={budget}
                        aria-invalid={budgetError ? true : undefined}
                        aria-describedby={budgetError ? `${id}-budget-error` : undefined}
                        onChange={(e) => setBudget(e.target.value)}
                        className="tabular-nums"
                      />
                    ),
                  },
                  {
                    id: `${id}-depth`,
                    label: "Max delegation depth",
                    control: (
                      <TextField
                        id={`${id}-depth`}
                        type="number"
                        min={1}
                        max={8}
                        aria-invalid={depthError ? true : undefined}
                        aria-describedby={depthError ? `${id}-depth-error` : undefined}
                        value={maxDepth}
                        onChange={(e) => setMaxDepth(Number(e.target.value))}
                        className="tabular-nums"
                      />
                    ),
                  },
                ]}
                hint={
                  <>
                    {spent
                      ? `Spent ${spent.text}. Leave the budget empty for no cap.`
                      : "Budget in US dollars: the router stops the project's requests at this amount."}{" "}
                    Delegation depth is the levels of sub-agents that may spawn their own, 1–8.
                  </>
                }
                status={
                  <>
                    {budgetError && (
                      <div id={`${id}-budget-error`}>
                        <Notice tone="error">{budgetError}</Notice>
                      </div>
                    )}
                    {depthError && (
                      <div id={`${id}-depth-error`}>
                        <Notice tone="error">{depthError}</Notice>
                      </div>
                    )}
                  </>
                }
              />
            </div>
          )}
        </div>
        {props.project && <ApprovalRules projectId={props.project.id} />}
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** A folder row's field: the chosen path (or a prompt) as a button that opens the folder picker (decision 49). */
function FolderField(props: {
  id: string;
  index: number;
  path: string;
  invalid: boolean;
  describedBy: string | undefined;
  autoOpen: boolean;
  current: string[];
  onChoose(path: string): void;
}) {
  const [open, setOpen] = useState(props.autoOpen);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        id={props.id}
        type="button"
        aria-label={`Folder ${props.index + 1}: ${props.path || "not chosen"}`}
        data-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.path || undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input-border bg-panel px-3 text-left text-sm hover:bg-hover data-invalid:border-err",
          open && "border-fg",
        )}
      >
        <Glyph icon={FolderOpen} size={14} className="shrink-0 text-fg-3" />
        <span className={cn("min-w-0 flex-1 truncate", props.path ? "font-mono text-xs text-fg" : "text-fg-3")} dir={props.path ? "rtl" : undefined}>
          {props.path ? <bdi>{props.path}</bdi> : "Choose a folder…"}
        </span>
        <Glyph icon={ChevronDown} size={14} className="shrink-0 text-fg-3" />
      </button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Suspense fallback={null}>
            <FolderPicker
              anchor={button}
              label={`Folder ${props.index + 1}`}
              current={props.current}
              onChoose={props.onChoose}
              onClose={() => setOpen(false)}
            />
          </Suspense>
        )}
      </Presence>
    </>
  );
}

/** "Add folder" (or "Choose a folder…" while there is none): opens the folder picker, Browse… first (decision 71). */
function AddFolder(props: { first: boolean; current: string[]; onChoose(path: string): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={button}
        size="sm"
        variant="ghost"
        icon={Plus}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={props.first ? undefined : "text-fg-2"}
        onClick={() => setOpen((o) => !o)}
      >
        {props.first ? "Choose a folder…" : "Add folder"}
      </Button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Suspense fallback={null}>
            <FolderPicker anchor={button} label="Add folder" current={props.current} onChoose={props.onChoose} onClose={() => setOpen(false)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
