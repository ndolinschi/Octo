import type { ProjectSession } from "@octo/agent-client";
import { Square } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { canMoveToWorktree } from "../../lib/sessions/model";
import { Button } from "../primitives/Button";
import { IconMenu } from "../primitives/IconMenu";
import type { MenuItem } from "../primitives/Menu";
import { DetailHeader } from "../primitives/Panel";
import { TextField } from "../primitives/TextField";

/**
 * Title and actions of a session. A main session's "⋯" holds Open, Make default (not on the default one), Rename (the title becomes a
 * field: Enter saves, Esc leaves it), Archive / Unarchive, Open in tab and Delete (not on the current session or one that is working). An agent session
 * has "Open in tab"; any session has Stop while it works. The title wraps; it never truncates here.
 */
export function SessionHeader(props: {
  session: ProjectSession;
  line: string;
  renaming: boolean;
  busy: string | null;
  onStartRename(): void;
  onRename(title: string): void;
  onCancelRename(): void;
  onMakeDefault(): void;
  onMoveToWorktree?: (() => void) | undefined;
  /** Shows a main session's conversation (decision 96: its tab, or the conversation tab). */
  onOpen?: (() => void) | undefined;
  onArchive(next: boolean): void;
  /** "Delete" is offered only on a session that is not current and has nothing running (`canDelete`). */
  canDelete: boolean;
  onDelete(): void;
  onStop(): void;
  onOpenInTab?: (() => void) | undefined;
}) {
  const s = props.session;
  const main = s.kind === "main";
  const items: MenuItem[] = [];
  const isDefault = main && (s.default ?? s.current);
  if (props.onOpen) items.push({ id: "open", label: "Open", run: props.onOpen });
  if (main && !isDefault) items.push({ id: "default", label: "Make default", run: props.onMakeDefault });
  if (main) items.push({ id: "rename", label: "Rename", run: props.onStartRename });
  if (props.onMoveToWorktree && canMoveToWorktree(s)) items.push({ id: "worktree", label: "Move to worktree…", run: props.onMoveToWorktree });
  if (props.onOpenInTab) items.push({ id: "tab", label: "Open in new tab", run: props.onOpenInTab });
  // Archiving the current session is offered and refused with the reason (`current_session`); deleting it is not offered.
  items.push({ id: "archive", label: s.archived ? "Unarchive" : "Archive", run: () => props.onArchive(!s.archived) });
  if (props.canDelete) items.push({ id: "sep", separator: true }, { id: "delete", label: "Delete", run: props.onDelete });
  const working = s.state === "working" || s.state === "waiting";
  return (
    <DetailHeader
      title={props.renaming ? <RenameField initial={s.title} onSave={props.onRename} onCancel={props.onCancelRename} /> : s.title}
      meta={props.line}
      actions={
        <>
          {working && (
            <Button variant="quiet" size="sm" icon={Square} loading={props.busy === "stop"} onClick={props.onStop}>
              Stop
            </Button>
          )}
          {items.length > 0 && <IconMenu label="Session actions" items={items} />}
        </>
      }
    />
  );
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave(title: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const save = () => (value.trim() === "" || value.trim() === initial ? onCancel() : onSave(value.trim()));
  // Enter and Esc hand focus back to the header's "⋯" (the field goes away); its blur then does nothing more.
  const finish = (fn: () => void) => {
    done.current = true;
    input.current?.closest("[data-detail-header]")?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.focus();
    fn();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(save);
    } else if (e.key === "Escape") {
      // Leaves the field only: the list-detail layout must not also go back.
      e.preventDefault();
      e.stopPropagation();
      finish(onCancel);
    }
  };
  return (
    <TextField
      ref={input}
      // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just chose Rename: the field is what they asked for
      autoFocus
      aria-label="Session title"
      size="sm"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => done.current || save()}
    />
  );
}
