import type { Project } from "@octo/agent-client";
import { useId, useState } from "react";
import { Select } from "../primitives/Select";
import { SELECT_W, SettingsGroup, SettingsRow } from "./parts";

/** The project chosen in any section's scope menu, kept while Settings is open, so every section opens on the same one. */
let remembered: string | null = null;

/** Projects in a stable order (by name): a list must not reorder while a person edits one of them (B11). */
export const byName = (a: Pick<Project, "name">, b: Pick<Project, "name">) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * B10: the one way per-project settings are chosen — a scope menu at the top of the section (Models, Commands, Editor,
 * Memory, Budget). It starts on the project chosen last in Settings, else the one open in the app, else the first by name.
 */
export function useProjectScope(projects: readonly Project[], openProject: string | null) {
  const [pick, setPick] = useState<string | null>(() => remembered ?? openProject);
  const sorted = [...projects].sort(byName);
  const project = sorted.find((p) => p.id === pick) ?? sorted.find((p) => p.id === openProject) ?? sorted[0];
  const choose = (id: string) => {
    remembered = id;
    setPick(id);
  };
  return { sorted, project, choose };
}

/** The scope menu: one row, "Settings for" and a select; `extra` puts options before the projects (Models: the defaults). */
export function ScopeRow(props: {
  projects: readonly Project[];
  value: string;
  onChange(id: string): void;
  description: string;
  extra?: readonly { value: string; label: string }[];
}) {
  const id = useId();
  return (
    // No caption: "Settings for" names the choice, and a caption over it made four headings in a row (Models).
    <SettingsGroup name="Project">
      <SettingsRow
        title="Settings for"
        htmlFor={id}
        description={props.description}
        control={
          <div className={SELECT_W}>
            <Select
              size="sm"
              id={id}
              label="Settings for"
              value={props.value}
              options={[
                ...(props.extra ?? []),
                ...props.projects.map((p) => ({ value: p.id, label: p.name, ...(props.extra?.length ? { group: "Projects" } : {}) })),
              ]}
              onChange={props.onChange}
            />
          </div>
        }
      />
    </SettingsGroup>
  );
}
