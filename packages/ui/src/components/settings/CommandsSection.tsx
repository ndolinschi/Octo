import type { Project, ProjectCommand, ProjectInput, ReviewConfig } from "@octo/agent-client";
import { useId, useState } from "react";
import { renameOffered } from "../../lib/commands/config";
import { errorMessage } from "../../lib/format";
import { Button } from "../primitives/Button";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { CommandDialog, GlobsDialog, OfferedDialog } from "./CommandDialogs";
import { LoadErrorRow, SaveStatus, SELECT_W, SettingsGroup, SettingsRow } from "./parts";
import { ScopeRow, useProjectScope } from "./scope";
import { useProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";

type Update = (id: string, patch: Partial<ProjectInput>) => Promise<void>;
type Editing = { kind: "command"; index: number | null } | { kind: "offered" } | { kind: "globs" } | null;

const PREFER = [
  { id: "auto", label: "By width" },
  { id: "unified", label: "One column" },
  { id: "split", label: "Side by side" },
] as const;

const DEFAULT_REVIEW: ReviewConfig = { commands: [], mechanical_globs: [], prefer: "auto" };

/**
 * Project scope (decision 74, 78): the project's named commands, and what a pull request review does with them: which are
 * offered, which paths fold as mechanical, one column or side by side. One project at a time; the harness validates, the
 * form says why before it saves.
 */
export function CommandsSection({ projectId }: { projectId: string | null }) {
  const { details, update, retry } = useProjectDetails();
  // B10: the same scope menu as Models, Editor, Memory and Budget (hooks before the early returns).
  const { sorted, project, choose } = useProjectScope(details.status === "ready" ? details.projects : [], projectId);
  if (details.status === "loading")
    return (
      <SettingsGroup label="Commands">
        <SkeletonList count={2} size="lg" twoLine />
      </SettingsGroup>
    );
  if (details.status === "error")
    return (
      <SettingsGroup label="Commands">
        <LoadErrorRow what="projects" message={details.message} hint="Check that Octo's local service is running, then retry." onRetry={retry} />
      </SettingsGroup>
    );
  if (details.projects.length === 0)
    return (
      <SettingsGroup label="Commands">
        <SettingsRow title="No projects yet" description="Each project gets its own commands and review settings here." />
      </SettingsGroup>
    );
  if (!project) return null;
  return (
    <>
      <ScopeRow projects={sorted} value={project.id} onChange={choose} description="Pick a project: these settings are per project." />
      <ProjectCommands key={project.id} project={project} update={update} />
    </>
  );
}

function ProjectCommands({ project, update }: { project: Project; update: Update }) {
  const commands = project.commands ?? [];
  const review = project.review ?? DEFAULT_REVIEW;
  const [editing, setEditing] = useState<Editing>(null);
  const [saved, run] = useSave();
  const preferId = useId();

  /** Saves and closes on success; on failure the sentence goes back to the dialog, nothing is closed. */
  const save = async (patch: Partial<ProjectInput>): Promise<string | null> => {
    try {
      await update(project.id, patch);
      setEditing(null);
      return null;
    } catch (e) {
      return `${errorMessage(e).replace(/\.$/, "")}. Nothing was changed; try again.`;
    }
  };
  const saveCommands = (next: ProjectCommand[]) => save({ commands: next });
  const at = editing?.kind === "command" ? editing.index : null;
  const editingCommand = at === null ? null : (commands[at] ?? null);
  // A removed command also leaves the review's offered list, so the list never names a command that is gone.
  const withoutName = (name: string) => review.commands.filter((n) => n.toLowerCase() !== name.toLowerCase());

  return (
    <>
      <SettingsGroup
        label="Commands"
        id="row-project-commands"
        footer="Start them from a pull request's Run menu or by name. Only you can start them; agents can't."
      >
        {commands.length === 0 && <SettingsRow title="No commands yet" description="Add the ones you run often: tests, a dev server, a build." />}
        {commands.map((c, i) => (
          <SettingsRow
            key={c.name}
            title={c.name}
            description={
              // The command line in mono; the words about it in the row's own face.
              <span className="text-xs">
                <span className="font-mono">{c.command}</span>
                {c.pinned ? " · in the header" : ""}
              </span>
            }
            control={
              <Button size="sm" onClick={() => setEditing({ kind: "command", index: i })}>
                Edit
              </Button>
            }
          />
        ))}
        <SettingsRow
          title="Add a command"
          description="Or add suggestions from package.json, the Makefile and the justfile in a review's Run menu."
          control={
            <Button size="sm" onClick={() => setEditing({ kind: "command", index: null })}>
              Add
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup label="Pull request review" id="row-review-config">
        <SettingsRow
          rowId="review-commands"
          title="Commands offered"
          description={review.commands.length ? review.commands.join(", ") : "Every command"}
          control={
            <Button size="sm" onClick={() => setEditing({ kind: "offered" })}>
              Choose
            </Button>
          }
        />
        <SettingsRow
          rowId="review-mechanical"
          title="Folded as mechanical"
          description={review.mechanical_globs.length ? review.mechanical_globs.join(", ") : "Only lock files and generated files"}
          control={
            <Button size="sm" onClick={() => setEditing({ kind: "globs" })}>
              Edit
            </Button>
          }
        />
        <SettingsRow
          rowId="review-prefer"
          title="Diff layout"
          htmlFor={preferId}
          description="Side by side needs room; narrow panes use one column."
          status={<SaveStatus state={saved} />}
          control={
            <div className={SELECT_W}>
              <Select
                size="sm"
                id={preferId}
                label="Diff layout"
                value={review.prefer}
                options={PREFER.map((o) => ({ value: o.id, label: o.label }))}
                onChange={(value) => {
                  const v = PREFER.find((o) => o.id === value)?.id;
                  if (v) void run(() => update(project.id, { review: { ...review, prefer: v } }));
                }}
              />
            </div>
          }
        />
      </SettingsGroup>
      {editing?.kind === "command" && (
        <CommandDialog
          key={at ?? "new"}
          initial={editingCommand}
          others={commands.filter((_, i) => i !== at)}
          onSave={(c) =>
            at === null || !editingCommand
              ? saveCommands(at === null ? [...commands, c] : commands)
              : save({
                  commands: commands.map((x, i) => (i === at ? c : x)),
                  // A rename follows into the review's offered list (it holds names), so the command stays offered.
                  ...(editingCommand.name !== c.name ? { review: { ...review, commands: renameOffered(review.commands, editingCommand.name, c.name) } } : {}),
                })
          }
          {...(editingCommand
            ? {
                onRemove: () => save({ commands: commands.filter((_, i) => i !== at), review: { ...review, commands: withoutName(editingCommand.name) } }),
              }
            : {})}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "offered" && (
        <OfferedDialog
          all={commands}
          chosen={review.commands}
          onSave={(names) => save({ review: { ...review, commands: names } })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "globs" && (
        <GlobsDialog
          initial={review.mechanical_globs}
          onSave={(globs) => save({ review: { ...review, mechanical_globs: globs } })}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
