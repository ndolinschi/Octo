import type { Note } from "@octo/agent-client";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { excerpt, formatRelative } from "../../lib/format";
import { useProject } from "../../state/project";
import { Button, IconButton } from "../primitives/Button";
import { Input, Textarea } from "../primitives/Field";
import { Markdown } from "../chat/Markdown";

export function NotesPanel() {
  const { state, createNote, updateNote, deleteNote } = useProject();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const notes = useMemo(
    () => [...state.notes].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [state.notes],
  );
  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 pr-2 pl-4 text-xs text-fg-3">
        <span>The orchestrator reads these every turn</span>
        <IconButton icon={Plus} label="Add note" size="sm" className="ml-auto" onClick={() => setEditing("new")} disabled={editing === "new"} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {editing === "new" && (
          <NoteEditor
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              await createNote(input);
              setEditing(null);
            }}
          />
        )}
        {notes.length === 0 && editing !== "new" && (
          <div className="px-2 py-3 text-sm">
            <p className="text-fg">No notes yet</p>
            <p className="mt-0.5 text-fg-2">Decisions and facts the orchestrator saves appear here.</p>
            <Button size="sm" className="mt-3" onClick={() => setEditing("new")}>
              Add note
            </Button>
          </div>
        )}
        <ul className="flex flex-col">
          {notes.map((note) =>
            editing === note.id ? (
              <li key={note.id}>
                <NoteEditor
                  note={note}
                  onCancel={() => setEditing(null)}
                  onSave={async (input) => {
                    await updateNote(note.id, input);
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <NoteItem key={note.id} note={note} now={now} onEdit={() => setEditing(note.id)} onDelete={() => deleteNote(note.id)} />
            ),
          )}
        </ul>
      </div>
    </div>
  );
}

function NoteItem(props: { note: Note; now: number; onEdit(): void; onDelete(): Promise<void> }) {
  const { note } = props;
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="group rounded-sm px-2 py-2 transition-[background-color] duration-100 hover:bg-hover">
      <div className="flex h-6 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{note.title}</h3>
        <div className="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton icon={Pencil} label={`Edit ${note.title}`} size="sm" onClick={props.onEdit} />
          <IconButton icon={Trash2} label={`Delete ${note.title}`} size="sm" onClick={() => setConfirming(true)} />
        </div>
      </div>
      <p className="text-xs text-fg-3">
        {note.author === "orchestrator" ? "Orchestrator" : "You"} ·{" "}
        <time dateTime={note.updated_at}>{formatRelative(note.updated_at, props.now)}</time>
      </p>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="mt-1 block w-full rounded-xs text-left"
      >
        {expanded ? (
          <Markdown text={note.content} className="octo-prose text-[13px]! text-fg-2!" />
        ) : (
          <p className="line-clamp-2 text-sm text-fg-2">{excerpt(note.content, 400)}</p>
        )}
      </button>
      {confirming && (
        <div role="alertdialog" aria-label="Confirm delete" className="mt-2 flex items-center gap-2 text-sm">
          <span className="flex-1 text-fg-2">Delete this note?</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => void props.onDelete()} autoFocus>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}

function NoteEditor(props: {
  note?: Note;
  onCancel(): void;
  onSave(input: { title: string; content: string }): Promise<void>;
}) {
  const [title, setTitle] = useState(props.note?.title ?? "");
  const [content, setContent] = useState(props.note?.content ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = title.trim() && content.trim();

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await props.onSave({ title: title.trim(), content: content.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-2 flex flex-col gap-2 px-2 pt-1 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
      }}
    >
      <Input aria-label="Note title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <Textarea aria-label="Note content" placeholder="What should the orchestrator remember?" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
      {error && <p className="text-xs text-err">{error}</p>}
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!valid || busy}>
          {props.note ? "Save" : "Add note"}
        </Button>
      </div>
    </form>
  );
}
