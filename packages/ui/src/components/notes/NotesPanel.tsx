import { ArrowLeft, Pin, Plus, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Note } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { useRowKeys } from "../../lib/hooks";
import { filterNotes, indexFooter, noteFileName, sortNotes, titleFromFileName } from "../../lib/notes";
import { useProject } from "../../state/project";
import { Button, IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Input } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { FloatRoom } from "../primitives/floatRoom";
import { NoteDetail } from "./NoteDetail";
import { NoteEditor } from "./NoteEditor";
import { useNoteDoc } from "./useNoteDoc";

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new" };

/**
 * Project notes (M5): Markdown documents the model sees as an index of titles and descriptions. List and detail, as
 * Memory (decision 66): side by side from 640px of panel width, two steps below. The footer says what the model gets.
 */
export function NotesPanel() {
  const { state, createNote, updateNote, deleteNote } = useProject();
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useRowKeys(list);
  const now = Date.now();

  const sorted = useMemo(() => sortNotes(state.notes), [state.notes]);
  const shown = useMemo(() => filterNotes(sorted, query), [sorted, query]);
  const selected = state.notes.find((n) => n.id === chosen) ?? null;
  // Wide: the first note is open so the detail is never an empty sentence in a corner. Narrow: nothing is open until chosen.
  const current = mode.kind === "new" ? null : (selected ?? shown[0] ?? null);
  const doc = useNoteDoc(current);
  const open = chosen !== null || mode.kind === "new";

  const pick = (id: string | null) => {
    setChosen(id);
    setMode({ kind: "view" });
    setPinError(null);
  };

  const importFile = async (file: File) => {
    setProblem(null);
    try {
      const made = await createNote({ markdown: await file.text(), title: titleFromFileName(file.name) });
      pick(made.id);
    } catch (e) {
      setProblem(`Couldn't import ${file.name}: ${errorMessage(e)}. Fix it and import again.`);
    }
  };

  const exportMarkdown = (note: Note, markdown: string) => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = noteFileName(note.title);
    a.click();
    URL.revokeObjectURL(url);
  };

  const togglePin = async (note: Note) => {
    setPinError(null);
    try {
      await updateNote(note.id, { pinned: !note.pinned });
    } catch (e) {
      setPinError(`Couldn't ${note.pinned ? "unpin" : "pin"} the note: ${errorMessage(e)}`);
    }
  };

  const detail =
    mode.kind === "new" ? (
      <NoteEditor
        notes={state.notes}
        onCancel={() => setMode({ kind: "view" })}
        onSave={async (input) => {
          const made = await createNote(input);
          pick(made.id);
        }}
      />
    ) : current === null ? null : mode.kind === "edit" && doc.status === "ok" ? (
      <NoteEditor
        key={current.id}
        note={doc.doc}
        notes={state.notes}
        onCancel={() => setMode({ kind: "view" })}
        onSave={async (input) => {
          await updateNote(current.id, input);
          setMode({ kind: "view" });
        }}
      />
    ) : (
      <NoteDetail
        note={current}
        load={doc}
        now={now}
        pinError={pinError}
        onEdit={() => setMode({ kind: "edit" })}
        onTogglePin={() => togglePin(current)}
        onExport={(md) => exportMarkdown(current, md)}
        onDelete={async () => {
          await deleteNote(current.id);
          pick(null);
        }}
      />
    );

  return (
    <div className="@container/notes flex h-full min-h-0 flex-col pt-pane" data-notes>
      <div className="flex h-row shrink-0 items-center gap-1 px-pane">
        <Input
          type="search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 min-w-0 flex-1"
        />
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          hidden
          aria-label="Import a note from a .md file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <IconButton icon={Upload} label="Import a .md file" onClick={() => fileInput.current?.click()} />
        <IconButton icon={Plus} label="Add note" onClick={() => setMode({ kind: "new" })} disabled={mode.kind === "new"} />
      </div>
      {problem && (
        <p role="alert" className="px-pane pb-1 text-xs text-err">
          {problem}
        </p>
      )}
      {state.notes.length === 0 && mode.kind !== "new" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            title="No notes yet"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setMode({ kind: "new" })}>
                Add note
              </Button>
            }
          >
            Decisions and facts saved while working appear here.
          </EmptyState>
        </div>
      ) : (
        <div role="group" aria-label="Notes" className="flex min-h-0 flex-1 flex-col border-t border-line @min-[640px]/notes:flex-row">
          <section
            aria-label="Note list"
            className={cn(
              "min-h-0 flex-col @min-[640px]/notes:flex @min-[640px]/notes:w-[clamp(220px,34%,340px)] @min-[640px]/notes:shrink-0 @min-[640px]/notes:border-r @min-[640px]/notes:border-line",
              open ? "hidden" : "flex flex-1",
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-pane py-2">
              {shown.length === 0 ? (
                <p className="px-2 py-3 text-sm text-fg-3">No note matches "{query}".</p>
              ) : (
                <ul ref={list} aria-label="Notes" className="flex flex-col">
                  {shown.map((n) => (
                    <NoteRow key={n.id} note={n} active={current?.id === n.id && mode.kind !== "new"} onPick={() => pick(n.id)} />
                  ))}
                </ul>
              )}
              <FloatRoom />
            </div>
          </section>
          <section aria-label="Detail" className={cn("min-h-0 min-w-0 flex-1 flex-col @min-[640px]/notes:flex", open ? "flex" : "hidden")}>
            <div className="flex h-row shrink-0 items-center px-pane @min-[640px]/notes:hidden">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => pick(null)}>
                Notes
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{detail}</div>
          </section>
        </div>
      )}
      <p className="line-clamp-2 shrink-0 border-t border-line px-pane py-1 text-xs text-fg-3" data-notes-footer>
        {indexFooter(state.notes)}
      </p>
    </div>
  );
}

function NoteRow(props: { note: Note; active: boolean; onPick(): void }) {
  const { note } = props;
  return (
    <li>
      <button
        type="button"
        data-row
        aria-current={props.active ? "true" : undefined}
        onClick={props.onPick}
        className={cn(
          "flex h-10 w-full min-w-0 flex-col justify-center rounded-sm px-2 text-left press-row focus-inset hover:bg-hover",
          props.active && "bg-active",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {note.pinned && <Glyph icon={Pin} size={14} aria-label="Pinned" className="shrink-0 text-fg-3" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{note.title}</span>
          {note.tags.length > 0 && <span className="max-w-[40%] shrink-0 truncate text-xs text-fg-3">{note.tags.map((t) => `#${t}`).join(" ")}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg-2">{note.description || "No description"}</span>
          {note.description_auto && (
            <span className="shrink-0 text-fg-3" title="Auto description: taken from the first line of the note">
              auto description
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
