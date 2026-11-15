import { useState, type RefObject } from "react";
import { navigate } from "../../lib/route";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { Popover } from "../primitives/Popover";
import { Select } from "../primitives/Select";
import { failureText } from "./useSessionActions";

/**
 * Decision 96: a new main session of a project, from the Sessions view's "+" when there are multiple projects to choose
 * from. The session is created without asking for a title (named automatically once its first turn runs).
 */
export function NewSessionPopover(props: {
  anchor: RefObject<HTMLElement | null>;
  /** The project; absent: a project select (the Sessions view). */
  projectId?: string;
  onClose(): void;
}) {
  const { bridge, projects } = useApp();
  const activity = useActivity();
  const [project, setProject] = useState(props.projectId ?? projects?.[0]?.id ?? "");
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
      navigate(project, null, session.id);
    } catch (e) {
      setError(failureText(e));
      setBusy(false);
    }
  };
  return (
    <Popover anchor={props.anchor} label="New session" onClose={props.onClose} align="end" className="w-72 p-3">
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
