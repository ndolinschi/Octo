import type { AccessMode, Models, Project, ProjectInput, TierPolicy } from "@octo/agent-client";
import { ACCESS_DETAIL, ACCESS_LABEL, ACCESS_MODES } from "../../lib/access";
import { modelsPatchForSessionChoice } from "../../lib/models";
import { budgetState, parseBudget, TIER_POLICIES } from "../../lib/modelsMore";
import { ModelPicker } from "../shared/ModelPicker";
import { Segmented } from "../primitives/Segmented";
import { ChevronDown, ChevronRight, FolderOpen, Plus, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { Presence } from "../primitives/Presence";

/** The folder picker loads with the first folder field opened (its own chunk). */
const FolderPicker = lazy(() => import("../shared/FolderPicker").then((m) => ({ default: m.FolderPicker })));
import { Glyph } from "../primitives/Glyph";
import { useId, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { FIELD } from "../../lib/controls";
import { errorMessage } from "../../lib/format";
import { folderName, labelsForFolders } from "../../lib/folderPick";
import { canRun, choosable, chipLabel, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field } from "../primitives/Field";
import { FieldRow } from "../primitives/FieldRow";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { TextArea, TextField } from "../primitives/TextField";
import { notReady } from "../../lib/errors/modelReadiness";
import { ApprovalRules } from "./ApprovalRules";
import { ModelNotice } from "./ModelNotice";

type FolderRow = { key: number; path: string };

const MODEL_FIELDS: { key: "orchestrator" | "fast" | "balanced" | "deep"; label: string }[] = [
  { key: "orchestrator", label: "Default model" },
  { key: "fast", label: "Fast tier" },
  { key: "balanced", label: "Balanced tier" },
  { key: "deep", label: "Deep tier" },
];

const FALLBACK_MODELS: Models = { orchestrator: "", fast: "", balanced: "", deep: "" };

/**
 * B3: what was typed in "New project" survives Esc, Cancel and a click outside until Create succeeds or "Clear" is pressed
 * (this tab only, in memory: nothing is written anywhere).
 */
type Draft = { name: string; nameTouched: boolean; description: string; instructions: string; folders: FolderRow[] };
const draftStore: { draft: Draft | null } = { draft: null };

function isAbsolute(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function ProjectDialog(props: { project?: Project; onClose(): void; onSubmit(input: ProjectInput): Promise<void>; onDelete?(): Promise<void> }) {
  const { config, bridge } = useApp();
  const providers = useProviders(bridge);
  const editing = Boolean(props.project);
  const initialModels = props.project?.models ?? config?.default_models ?? FALLBACK_MODELS;
  const kept = editing ? null : draftStore.draft;
  const [hadDraft, setHadDraft] = useState(kept !== null);
  const [name, setName] = useState(props.project?.name ?? kept?.name ?? "");
  /** The name follows the first folder until the person types one (decision 71). */
  const [nameTouched, setNameTouched] = useState(editing || (kept?.nameTouched ?? false));
  const [description, setDescription] = useState(props.project?.description ?? kept?.description ?? "");
  const [instructions, setInstructions] = useState(props.project?.instructions ?? kept?.instructions ?? "");
  const [folders, setFolders] = useState<FolderRow[]>(() => {
    const rows = props.project?.folders.map((f, i) => ({ key: i, path: f.path })) ?? kept?.folders ?? [];
    return rows.length ? rows : [{ key: 0, path: "" }];
  });
  const [models, setModels] = useState<Models>(initialModels);
  /** A model the person chose is never replaced by the default that can run. */
  const modelsTouched = useRef(editing);
  const [maxDepth, setMaxDepth] = useState(props.project?.max_depth ?? config?.default_max_depth ?? 3);
  const [budget, setBudget] = useState(props.project?.budget_usd ? String(props.project.budget_usd) : "");
  const [policy, setPolicy] = useState<TierPolicy>(props.project?.models.tier_policy ?? "auto");
  const [access, setAccess] = useState<AccessMode>(props.project?.access ?? (editing ? "full" : "supervised"));
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
  const issues = list
    ? notReady(
        list,
        MODEL_FIELDS.map((m) => models[m.key]),
        editing,
      )
    : [];
  // B2: a new project starts on models that can run when one is connected (never over a choice the person made).
  const ready = providers.status === "ready" ? providers.list : null;
  useEffect(() => {
    if (!ready || modelsTouched.current) return;
    const first = choosable(ready)[0]?.value;
    if (!first) return;
    modelsTouched.current = true;
    setModels(
      (cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, typeof v === "string" && v !== "" && !canRun(ready, v) ? first : v])) as Models,
    );
  }, [ready]);
  const [advanced, setAdvanced] = useState(false);
  /** The folder row whose picker opens by itself ("Add folder"). */
  const [openFolderKey, setOpenFolderKey] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const id = useId();
  const live = useRef<Draft>({ name, nameTouched, description, instructions, folders });
  live.current = { name, nameTouched, description, instructions, folders };
  const created = useRef(false);
  useEffect(
    () => () => {
      if (!editing && !created.current)
        draftStore.draft =
          live.current.name || live.current.description || live.current.instructions || live.current.folders.some((f) => f.path) ? live.current : null;
    },
    [editing],
  );
  const clearDraft = () => {
    draftStore.draft = null;
    setHadDraft(false);
    setName("");
    setNameTouched(false);
    setDescription("");
    setInstructions("");
    setFolders([{ key: 0, path: "" }]);
  };

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
      created.current = true;
      draftStore.draft = null;
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
        access,
        ...budgetPatch,
      });
    } catch (err) {
      created.current = false;
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
      {...(editing ? { description: "Changes apply from the next request." } : {})}
      onClose={props.onClose}
      footer={
        confirmDelete ? (
          <>
            <p className="basis-full text-sm text-fg-2 max-[420px]:order-last max-[420px]:basis-auto sm:flex-1 sm:basis-0">
              Delete <span className="text-fg">{props.project?.name}</span> and its history? This can't be undone.
            </p>
            <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()} disabled={busy} autoFocus>
              Delete project
            </Button>
          </>
        ) : (
          <>
            {props.onDelete && (
              <Button variant="quiet" className="text-err! hover:text-err! min-[421px]:mr-auto min-[421px]:-ml-3" onClick={() => setConfirmDelete(true)}>
                Delete project
              </Button>
            )}
            <Button variant="quiet" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={id} loading={busy} disabled={busy}>
              {editing ? "Save changes" : "Create project"}
            </Button>
          </>
        )
      }
    >
      <form id={id} onSubmit={submit} noValidate className="@container flex flex-col gap-6">
        {hadDraft && (
          <p className="-mb-3 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            Your earlier draft is back.
            <Button variant="link" tone="quiet" onClick={clearDraft}>
              Discard draft
            </Button>
          </p>
        )}
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
                <span
                  key={f.key}
                  title={f.path}
                  className="inline-flex h-ctl-sm max-w-full items-center gap-1 rounded-sm bg-raised pr-0.5 pl-2 text-sm text-fg"
                >
                  <Glyph icon={FolderOpen} size={14} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 truncate">{folderName(f.path)}</span>
                  <IconButton icon={X} size="xs" label={`Remove ${folderName(f.path)}`} onClick={() => removeFolder(f.key)} />
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
                    size="xs"
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
              variant="quiet"
              icon={Plus}
              className="-mb-1 -ml-2 w-fit"
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
            className="-mt-1.5 -ml-3"
          >
            Models and agents
          </Button>
          <p className="text-xs text-fg-3">Which models do the work, how many levels of agents may start agents, and an optional budget.</p>
          {advanced && (
            <div id={`${id}-models`} className="mt-3 grid gap-3">
              <p className="text-xs text-fg-3">Fast: quick, cheap work. Balanced: most tasks. Deep: hard problems, highest cost.</p>
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
                      onChoose={(v) => {
                        modelsTouched.current = true;
                        setModels((cur) => (m.key === "orchestrator" ? { ...cur, ...modelsPatchForSessionChoice(v, cur) } : { ...cur, [m.key]: v }));
                      }}
                    />
                  </Field>
                ))}
              </div>
              {router && (
                <Field
                  label="Model choice"
                  hint={
                    <span className="grid gap-0.5">
                      {TIER_POLICIES.map((p) => (
                        <span key={p.value}>
                          <span className={p.value === policy ? "text-fg-2" : undefined}>{p.label}:</span> {p.detail}
                        </span>
                      ))}
                    </span>
                  }
                >
                  <Segmented<TierPolicy>
                    label="Model choice"
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
                        leading="$"
                        placeholder="Set budget"
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
                    label: "Max agent depth",
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
                      ? `Spent ${spent.text}. Checked between steps, so a step already running can go over.`
                      : "Budget in US dollars, checked between steps: a running step can go over."}{" "}
                    Agent depth: how many levels of agents may start other agents (1–8).
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
        <Field
          label="Permissions"
          hint={
            <span className="grid gap-0.5">
              {ACCESS_MODES.map((m) => (
                <span key={m}>
                  <span className={m === access ? "text-fg-2" : undefined}>{ACCESS_LABEL[m]}:</span> {ACCESS_DETAIL[m]}.
                </span>
              ))}
            </span>
          }
        >
          <Segmented<AccessMode>
            label="Permissions"
            value={access}
            onChange={setAccess}
            options={ACCESS_MODES.map((m) => ({ id: m, label: ACCESS_LABEL[m], title: ACCESS_DETAIL[m] }))}
          />
        </Field>
        {props.project && <ApprovalRules projectId={props.project.id} />}
        {/* Decision 2026-11-15: a model that cannot run is said calmly with the way forward; Create stays on. */}
        {issues.map((issue) => (
          <ModelNotice
            key={issue.text}
            issue={issue}
            onChoose={() => {
              setAdvanced(true);
              requestAnimationFrame(() => document.getElementById(`${id}-models`)?.scrollIntoView({ block: "nearest" }));
            }}
          />
        ))}
        {error && <Notice tone="error">{error}</Notice>}
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
        className={cn(FIELD, "flex h-ctl-md min-w-0 flex-1 items-center gap-2 px-3 text-left hover:bg-hover data-invalid:border-err", open && "border-fg")}
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
        variant="quiet"
        icon={Plus}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The glyph of the first button sits on the fields' left edge (C3): its 8px padding is pulled out.
        className={props.first ? "-mb-1 -ml-2" : "text-fg-2"}
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
