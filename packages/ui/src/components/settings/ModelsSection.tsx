import type { ProviderList } from "@octo/agent-client";
import { useId, useMemo, useState } from "react";
import { useHiddenModels, useProviders } from "../../lib/providers";
import { useApp } from "../../state/app";
import { Select } from "../primitives/Select";
import { SkeletonList } from "../primitives/Skeleton";
import { useHarnessSettings } from "./harnessSettings";
import { modelOptions, MODEL_ROWS, TIERS_NOTE, type ModelRow } from "./modelRows";
import { LoadErrorRow, SELECT_W, SaveStatus, SettingsGroup, SettingsRow } from "./parts";
import { ModelsProblem } from "./ModelsProblem";
import { ProjectModels } from "./ProjectModels";
import { ScopeRow, useProjectScope } from "./scope";
import { useProjectDetails } from "./useProjectDetails";
import { useSave } from "./useSave";
import { VisibleModels } from "./VisibleModels";

type Scope = "defaults" | "project";
const DEFAULTS = "__defaults__";

/**
 * Decisions 59 and 74: Models has two scopes, chosen in the section's scope menu (B10). "Defaults for new projects" is this
 * computer (the models new projects start with, and which models pickers show); a project is its own four models, inherited
 * from the defaults until changed. The menu is only offered while a project exists.
 */
export function ModelsSection(props: { projectId?: string | null }) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const harness = useHarnessSettings();
  const { details, update } = useProjectDetails();
  const [scope, setScope] = useState<Scope>("defaults");
  const list = providers.status === "ready" ? providers.list : null;
  // B10: the same scope menu as every per-project section; here it also offers the defaults for new projects.
  const { sorted, project, choose } = useProjectScope(details.status === "ready" ? details.projects : [], props.projectId ?? null);
  const projectScope = scope === "project" && project !== undefined;
  const loading = providers.status === "loading" || harness.load.status === "loading";
  return (
    <>
      {project && (
        <ScopeRow
          projects={sorted}
          value={projectScope ? project.id : DEFAULTS}
          extra={[{ value: DEFAULTS, label: "Defaults for new projects" }]}
          onChange={(v) => {
            if (v === DEFAULTS) return setScope("defaults");
            choose(v);
            setScope("project");
          }}
          description="New projects start with the defaults; each project can then change its own."
        />
      )}
      {projectScope && list && <ProjectModels key={project.id} project={project} list={list} update={update} />}
      {projectScope && !list && <SkeletonList count={4} size="lg" twoLine />}
      {!projectScope && (
        <>
          {list && harness.load.status === "ready" && (
            <ModelsProblem
              list={list}
              values={MODEL_ROWS.map((d) => (typeof harness.get(d.id)?.value === "string" ? String(harness.get(d.id)?.value) : ""))}
              onApply={(next) => harness.save({ set: Object.fromEntries(MODEL_ROWS.flatMap((d, i) => (next[i] !== undefined ? [[d.id, next[i]]] : []))) })}
            />
          )}
          <SettingsGroup label="Defaults for new projects" footer={TIERS_NOTE}>
            {loading && <SkeletonList count={MODEL_ROWS.length} size="lg" twoLine />}
            {harness.load.status === "unavailable" && (
              <SettingsRow title="Not available here" description="This connection cannot change the default models." />
            )}
            {harness.load.status === "error" && (
              <LoadErrorRow what="settings" message={harness.load.message} hint="Retry once Octo's local service is running." onRetry={harness.reload} />
            )}
            {providers.status === "error" && (
              <LoadErrorRow
                what="providers"
                message={providers.message.replace(/\.$/, "")}
                hint="Retry once Octo's local service is running."
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
        // The width sits on a wrapper: the select's own `w-full` would win over a `w-64` on it and size it by its text.
        <div className={SELECT_W}>
          <Select
            id={id}
            label={def.title}
            value={value}
            options={options}
            disabled={!s.editable || list.providers.every((p) => p.state !== "ready")}
            onChange={(v) => void run(() => harness.save({ set: { [def.id]: v } }))}
          />
        </div>
      }
    />
  );
}
