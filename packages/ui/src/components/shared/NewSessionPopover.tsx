import { useState, type RefObject } from "react";
import { navigate } from "../../lib/route";
import { failureText } from "../../lib/sessions/model";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { Button } from "../primitives/Button";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { Popover } from "../primitives/Popover";
import { Select } from "../primitives/Select";

/**
 * Decision 96: a new main session for a chosen project, with an explicit Project selector so the user can always pick
 * which project the session starts in. The session is created without asking for a title (named automatically once its first turn runs).
 */
export function NewSessionPopover(props: {
  anchor: RefObject<HTMLElement | null>;
  /** Initial project selection (pre-fills the Project dropdown while still allowing choosing any project). */
  projectId?: string;
  defaultProjectId?: string | null;
  /** Currently open project ID so starting a session in the open project opens a workspace tab cleanly. */
  activeProjectId?: string | null;
  align?: "start" | "end";
  onCreated?(): void;
  onClose(): void;
}) {
  const { bridge, projects } = useApp();
  const activity = useActivity();
  const nav = useNav();
  const initialProject = props.defaultProjectId ?? props.projectId ?? projects?.[0]?.id ?? "";
  const [project, setProject] = useState(initialProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (busy || project === "") return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await bridge.createSession(project, {});
      activity.refreshSessions();
      props.onClose();
      props.onCreated?.();
      if (project === props.activeProjectId && nav.workspace()) {
        nav.workspace()?.openSession(session.id);
      } else {
        navigate(project, null, session.id);
      }
    } catch (e) {
      setError(failureText(e));
      setBusy(false);
    }
  };
  return (
    <Popover anchor={props.anchor} label="New session" onClose={props.onClose} align={props.align ?? "end"} className="w-72 p-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <p className="text-sm text-fg">New session</p>
        <FieldRow
          fields={[
            {
              id: "new-session-project",
              label: "Project",
              control: (
                <Select
                  id="new-session-project"
                  label="Project"
                  size="sm"
                  className="w-full"
                  value={project}
                  onChange={setProject}
                  options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
                />
              ),
            },
          ]}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={project === ""}>
            Start
          </Button>
        </div>
      </form>
    </Popover>
  );
}
