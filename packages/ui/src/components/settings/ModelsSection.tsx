import type { ProviderList } from "@octo/agent-client";
import { useId, useMemo, useState } from "react";
import { useHiddenModels, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { ViewTabs } from "../primitives/ViewTabs";
import { useHarnessSettings } from "./harnessSettings";
import { modelOptions, MODEL_ROWS, type ModelRow } from "./modelRows";
import { CONTROL_W, LoadErrorRow, SaveStatus, SettingsGroup, SettingsRow } from "./parts";
import { ModelsProblem } from "./ModelsProblem";
import { ProjectModels } from "./ProjectModels";
import { useProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";
import { VisibleModels } from "./VisibleModels";

type Scope = "defaults" | "project";

/**
 * Decisions 59 and 74: Models has two scopes. "Defaults" is this machine (the models new projects start with, and which models
 * pickers show); the second tab is a project (its own four models, inherited from the defaults until changed). The tabs are
 * only offered while a project exists. Models are the one setting that has both levels today.
 */
export function ModelsSection(props: { projectId?: string | null }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const harness = useHarnessSettings();
  const { details, update } = useProjectDetails();
  const [scope, setScope] = useState<Scope>("defaults");
  // The project tab opens on the project that is open in the app (when it still exists), else the most recently updated one.
  const [pick, setPick] = useState<string | null>(props.projectId ?? null);
  const list = providers.status === "ready" ? providers.list : null;
  const projects = details.status === "ready" ? details.projects : [];
  const project = projects.find((p) => p.id === pick) ?? projects[0];
  const projectScope = scope === "project" && project !== undefined;
  const loading = providers.status === "loading" || harness.load.status === "loading";
  return (
    <>
      {project && (
        <ViewTabs<Scope>
          label="Settings scope"
          value={projectScope ? "project" : "defaults"}
          onChange={setScope}
          options={[
            { id: "defaults", label: "Defaults", title: "What this machine starts new projects with" },
            {
              id: "project",
              label: project.name,
              title: projects.length > 1 ? "This project's own models; press again to pick another project" : "This project's own models",
              // Several projects: the tab's label is the menu that chooses which one (the scope is chosen once, here).
              ...(projects.length > 1
                ? { menu: projects.map((p) => ({ id: p.id, label: p.name, checked: p.id === project.id, run: () => setPick(p.id) })) }
                : {}),
            },
          ]}
          className="px-0"
        />
      )}
      {projectScope && list && <ProjectModels key={project.id} project={project} list={list} update={update} />}
      {projectScope && !list && <SkeletonList count={4} size="lg" twoLine />}
      {!projectScope && (
        <>
          {list && harness.load.status === "ready" && (
            <ModelsProblem list={list} values={MODEL_ROWS.map((d) => (typeof harness.get(d.id)?.value === "string" ? String(harness.get(d.id)?.value) : ""))} />
          )}
          <SettingsGroup label="Defaults for new projects" footer="A project keeps the models it was created with; change them in its own tab.">
            {loading && <SkeletonList count={MODEL_ROWS.length} size="lg" twoLine />}
            {harness.load.status === "unavailable" && (
              <SettingsRow title="Not available here" description="This connection cannot change the harness's default models." />
            )}
            {harness.load.status === "error" && (
              <LoadErrorRow what="settings" message={harness.load.message} hint="Retry once the harness is running." onRetry={harness.reload} />
            )}
            {providers.status === "error" && (
              <LoadErrorRow
                what="providers"
                message={providers.message.replace(/\.$/, "")}
                hint="Retry once the harness is running."
                onRetry={() => void providers.refresh()}
              />
            )}
            {list && harness.load.status === "ready" && MODEL_ROWS.map((d) => <DefaultModelRow key={d.id} def={d} list={list} />)}
          </SettingsGroup>
          {list && <VisibleModels list={list} />}
        </>
      )}
    </>
  );
}

function DefaultModelRow({ def, list }: { def: ModelRow; list: ProviderList }) {
  const harness = useHarnessSettings();
  const [saved, run] = useSave();
  const [hidden] = useHiddenModels();
  const id = useId();
  const s = harness.get(def.id);
  const value = typeof s?.value === "string" ? s.value : "";
  const options = useMemo(() => modelOptions(list, new Set(hidden), value), [list, hidden, value]);
  if (!s) return null;
  return (
    <SettingsRow
      rowId={def.rowId}
      title={def.title}
      htmlFor={id}
      description={s.editable ? def.description : (s.note ?? `Set by the ${s.source}.`)}
      status={<SaveStatus state={saved} />}
      control={
        <Select
          id={id}
          label={def.title}
          value={value}
          options={options}
          disabled={!s.editable || list.providers.every((p) => p.state !== "ready")}
          onChange={(v) => void run(() => harness.save({ set: { [def.id]: v } }))}
          className={CONTROL_W.lg}
        />
      }
    />
  );
}
