import type { Models, Project, ProjectInput } from "@octo/agent-client";
import { ChevronDown, FolderPlus, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { basename } from "../../lib/format";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field, Input, Textarea } from "../primitives/Field";

type FolderRow = { key: number; path: string; label: string };

const MODEL_FIELDS: { key: keyof Models; label: string; hint: string }[] = [
  { key: "orchestrator", label: "Orchestrator", hint: "Runs the project chat" },
  { key: "fast", label: "Fast tier", hint: "Lookups, listing, quick reads" },
  { key: "balanced", label: "Balanced tier", hint: "Most implementation work" },
  { key: "deep", label: "Deep tier", hint: "Hard reasoning, reviews" },
];

const FALLBACK_MODELS: Models = { orchestrator: "", fast: "", balanced: "", deep: "" };

function isAbsolute(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function ProjectDialog(props: {
  project?: Project;
  onClose(): void;
  onSubmit(input: ProjectInput): Promise<void>;
  onDelete?(): Promise<void>;
}) {
  const { config } = useApp();
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
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = useId();

  const filled = folders.filter((f) => f.path.trim());
  const badPath = filled.find((f) => !isAbsolute(f.path.trim()));
  const valid = name.trim().length > 0 && !badPath && maxDepth >= 1 && maxDepth <= 8;

  const updateFolder = (key: number, patch: Partial<FolderRow>) =>
    setFolders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const changedModels = Object.fromEntries(
      (Object.keys(models) as (keyof Models)[]).filter((k) => models[k].trim()).map((k) => [k, models[k].trim()]),
    );
    try {
      await props.onSubmit({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        folders: filled.map((f) => ({ path: f.path.trim(), ...(f.label.trim() ? { label: f.label.trim() } : {}) })),
        models: changedModels,
        max_depth: maxDepth,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.onDelete) return;
    setBusy(true);
    try {
      await props.onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Dialog
      title={editing ? "Project settings" : "New project"}
      description={
        editing ? "Changes apply from the orchestrator's next turn." : "A project is one long-running conversation with its own orchestrator, folders and memory."
      }
      onClose={props.onClose}
      footer={
        confirmDelete ? (
          <>
            <p className="flex-1 text-sm text-fg-2">
              Delete <span className="font-medium text-fg">{props.project?.name}</span> and its whole history? This can't be undone.
            </p>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy} autoFocus>
              Delete project
            </Button>
          </>
        ) : (
          <>
            {props.onDelete && (
              <Button variant="ghost" className="-ml-2 text-err! hover:bg-err-soft!" onClick={() => setConfirmDelete(true)}>
                Delete project
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={id} disabled={!valid || busy}>
              {editing ? "Save changes" : "Create project"}
            </Button>
          </>
        )
      }
    >
      <form id={id} onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4">
          <Field label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Billing service"
              required
            />
          </Field>
          <Field label="Description" htmlFor={`${id}-desc`} optional>
            <Input
              id={`${id}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line about what this project is for"
            />
          </Field>
          <Field
            label="Instructions"
            htmlFor={`${id}-instr`}
            optional
            hint="Standing guidance for the orchestrator — conventions, constraints, what good looks like."
          >
            <Textarea
              id={`${id}-instr`}
              rows={4}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Prefer small, reviewable changes. Never touch the migrations folder without asking."
            />
          </Field>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm font-medium">Folders</legend>
          <p className="-mt-1 mb-1 text-xs text-fg-3">
            Absolute paths the agents may read and work in. Tools are confined to these folders.
          </p>
          {folders.map((f, i) => {
            const invalid = f.path.trim() !== "" && !isAbsolute(f.path.trim());
            return (
              <div key={f.key} className="flex items-center gap-2">
                <Input
                  aria-label={`Folder ${i + 1} path`}
                  aria-invalid={invalid}
                  value={f.path}
                  onChange={(e) => updateFolder(f.key, { path: e.target.value })}
                  placeholder="/Users/you/code/repo"
                  className={cn("flex-[2] font-mono text-xs", invalid && "border-err!")}
                />
                <Input
                  aria-label={`Folder ${i + 1} label`}
                  value={f.label}
                  onChange={(e) => updateFolder(f.key, { label: e.target.value })}
                  placeholder={f.path.trim() ? basename(f.path.trim()) : "label"}
                  className="flex-1"
                />
                <IconButton
                  icon={X}
                  label={`Remove folder ${i + 1}`}
                  onClick={() => setFolders((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== f.key) : [{ key: f.key + 1, path: "", label: "" }]))}
                />
              </div>
            );
          })}
          {badPath && <p className="text-xs text-err">Use an absolute path, like /Users/you/code/repo.</p>}
          <Button
            size="sm"
            variant="ghost"
            icon={FolderPlus}
            className="-ml-2 w-fit"
            onClick={() => setFolders((rows) => [...rows, { key: Math.max(...rows.map((r) => r.key)) + 1, path: "", label: "" }])}
          >
            Add folder
          </Button>
        </fieldset>

        <div className="border-t border-line pt-3">
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
            className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-sm px-1.5 text-sm font-medium text-fg-2 hover:bg-hover hover:text-fg"
          >
            <ChevronDown size={14} aria-hidden className={cn("transition-transform", !advanced && "-rotate-90")} />
            Models &amp; delegation
          </button>
          {advanced && (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                {MODEL_FIELDS.map((m) => (
                  <Field key={m.key} label={m.label} htmlFor={`${id}-m-${m.key}`} hint={m.hint}>
                    <Input
                      id={`${id}-m-${m.key}`}
                      value={models[m.key]}
                      onChange={(e) => setModels((cur) => ({ ...cur, [m.key]: e.target.value }))}
                      className="font-mono text-xs"
                    />
                  </Field>
                ))}
              </div>
              <Field label="Max delegation depth" htmlFor={`${id}-depth`} hint="How many levels of sub-agents may spawn their own sub-agents (1–8).">
                <Input
                  id={`${id}-depth`}
                  type="number"
                  min={1}
                  max={8}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                  className="w-24 tabular-nums"
                />
              </Field>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-err/25 bg-err-soft px-3 py-2 text-sm text-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
