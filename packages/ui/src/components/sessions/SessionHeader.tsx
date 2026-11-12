import type { ProjectSession } from "@octo/agent-client";
import { Square } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "../primitives/Button";
import { IconMenu } from "../primitives/IconMenu";
import type { MenuItem } from "../primitives/Menu";
import { TextField } from "../primitives/TextField";

/**
 * Title and actions of a session. A main session's "⋯" holds Resume (not on the current one), Rename (the title becomes a
 * field: Enter saves, Esc leaves it), Archive / Unarchive, Open in tab and Delete (not offered on the current one). An agent session
 * has Stop while it works and "Open in tab". The title wraps; it never truncates here.
 */
export function SessionHeader(props: {
  session: ProjectSession;
  line: string;
  renaming: boolean;
  busy: string | null;
  onStartRename(): void;
  onRename(title: string): void;
  onCancelRename(): void;
  onResume(): void;
  onArchive(next: boolean): void;
  onDelete(): void;
  onStop(): void;
  onOpenInTab?: (() => void) | undefined;
}) {
  const s = props.session;
  const main = s.kind === "main";
  const items: MenuItem[] = [];
  if (main && !s.current) items.push({ id: "resume", label: "Resume", run: props.onResume });
  if (main) items.push({ id: "rename", label: "Rename", run: props.onStartRename });
  if (props.onOpenInTab) items.push({ id: "tab", label: "Open in tab", run: props.onOpenInTab });
  // Archiving the current session is offered and refused with the reason (`current_session`); deleting it is not offered.
  items.push({ id: "archive", label: s.archived ? "Unarchive" : "Archive", run: () => props.onArchive(!s.archived) });
  if (!(main && s.current)) items.push({ id: "sep", separator: true }, { id: "delete", label: "Delete…", run: props.onDelete });
  const working = s.state === "working";
  return (
    <header className="flex min-w-0 items-start gap-2 px-2 pt-3 pb-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {props.renaming ? (
          <RenameField initial={s.title} onSave={props.onRename} onCancel={props.onCancelRename} />
        ) : (
          <h2 className="text-heading break-words text-fg">{s.title}</h2>
        )}
        <p className="truncate text-xs text-fg-3">{props.line}</p>
      </div>
      {!main && working && (
        <Button variant="quiet" size="sm" icon={Square} loading={props.busy === "stop"} onClick={props.onStop}>
          Stop
        </Button>
      )}
      {items.length > 0 && <IconMenu label="Session actions" items={items} />}
    </header>
  );
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave(title: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const save = () => (value.trim() === "" || value.trim() === initial ? onCancel() : onSave(value.trim()));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      // Leaves the field only: the list-detail layout must not also go back.
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <TextField
      // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just chose Rename: the field is what they asked for
      autoFocus
      aria-label="Session title"
      size="sm"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={save}
    />
  );
}
