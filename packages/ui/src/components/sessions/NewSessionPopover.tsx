import { useState, type RefObject } from "react";
import { navigate } from "../../lib/route";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { FieldRow } from "../primitives/FieldRow";
import { Notice } from "../primitives/Notice";
import { Popover } from "../primitives/Popover";
import { Select } from "../primitives/Select";
import { TextField } from "../primitives/TextField";
import { failureText } from "./useSessionActions";

/**
 * Decision 96: a new main session of a project, from the sidebar's "+" (a project row's, or the Sessions view's header with
 * a project to choose). Title is optional (the first request names it). It is not the default; it opens at once. The
 * workspace and memory controls of the spec come with worktrees (phase 3) and memory modes (phase 5).
 */
export function NewSessionPopover(props: {
  anchor: RefObject<HTMLElement | null>;
  /** The project; absent: a project select (the Sessions view). */
  projectId?: string;
  onClose(): void;
}) {
  const { bridge, projects } = useApp();
  const activity = useActivity();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(props.projectId ?? projects?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (busy || project === "") return;
    setBusy(true);
    setError(null);
    try {
      const t = title.trim();
      const { session } = await bridge.createSession(project, t === "" ? {} : { title: t });
      activity.refreshSessions();
      props.onClose();
      navigate(project, null, session.id);
    } catch (e) {
      setError(failureText(e));
      setBusy(false);
    }
  };
  const fields = [
    ...(props.projectId === undefined
      ? [
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
        ]
      : []),
    {
      id: "new-session-title",
      label: "Title",
      control: (
        <TextField
          id="new-session-title"
          size="sm"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just asked for a new session: its title is what they type next
          autoFocus
          placeholder="From the first request"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
      ),
    },
  ];
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
        {fields.map((f) => (
          <FieldRow key={f.id} fields={[f]} />
        ))}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={project === ""}>
            Create
          </Button>
        </div>
      </form>
    </Popover>
  );
}
