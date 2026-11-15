import type { Project, ProjectInput, ProviderList } from "@octo/agent-client";
import { useId, useMemo } from "react";
import { chipLabel, useHiddenModels } from "../../lib/providers";
import { Button } from "../primitives/Button";
import { Select } from "../primitives/Select";
import { useHarnessSettings } from "./harnessSettings";
import { ModelsProblem } from "./ModelsProblem";
import { modelOptions, MODEL_ROWS, TIERS_NOTE, type ModelRow } from "./modelRows";
import { SaveStatus, SELECT_W, SettingsGroup, SettingsRow } from "./parts";
import { useSave } from "./useSave";

/**
 * Decision 74, the project scope of Models: the project's own models, each saying "Inherited from defaults" while it equals the
 * default (the harness copies the defaults into a project when it is created, so "inherited" means equal today) and offering
 * "Reset to default" once it differs.
 */
export function ProjectModels(props: { project: Project; list: ProviderList; update(id: string, patch: Partial<ProjectInput>): Promise<void> }) {
  const harness = useHarnessSettings();
  return (
    <>
      <ModelsProblem
        list={props.list}
        values={MODEL_ROWS.map((row) => props.project.models[row.field])}
        onApply={(next) =>
          props.update(props.project.id, { models: Object.fromEntries(MODEL_ROWS.flatMap((row, i) => (next[i] !== undefined ? [[row.field, next[i]]] : []))) })
        }
      />
      <SettingsGroup
        label="Models for this project"
        id="row-project-models"
        footer={`${TIERS_NOTE} Changing a default later does not change existing projects.`}
      >
        {MODEL_ROWS.map((row) => {
          const d = harness.get(row.id)?.value;
          return <ProjectModelRow key={row.id} row={row} {...props} defaultValue={typeof d === "string" && d !== "" ? d : null} />;
        })}
      </SettingsGroup>
    </>
  );
}

function ProjectModelRow(props: {
  row: ModelRow;
  project: Project;
  list: ProviderList;
  defaultValue: string | null;
  update(id: string, patch: Partial<ProjectInput>): Promise<void>;
}) {
  const { row, project, list, defaultValue } = props;
  const [saved, run] = useSave();
  const [hidden] = useHiddenModels();
  const id = useId();
  const value = project.models[row.field];
  const options = useMemo(() => modelOptions(list, new Set(hidden), value), [list, hidden, value]);
  const inherited = defaultValue !== null && value === defaultValue;
  const set = (model: string) => void run(() => props.update(project.id, { models: { [row.field]: model } }));
  return (
    <SettingsRow
      rowId={`project-${row.rowId}`}
      title={row.title}
      htmlFor={id}
      description={
        defaultValue === null ? row.projectDescription : inherited ? "Same as the default" : `Set for this project. Default: ${chipLabel(defaultValue, list)}.`
      }
      status={<SaveStatus state={saved} />}
      control={
        <>
          {!inherited && defaultValue !== null && (
            <Button variant="quiet" size="sm" onClick={() => set(defaultValue)}>
              Reset to default
            </Button>
          )}
          <div className={SELECT_W}>
            <Select size="sm" id={id} label={`${row.title} of ${project.name}`} value={value} options={options} onChange={set} />
          </div>
        </>
      }
    />
  );
}
