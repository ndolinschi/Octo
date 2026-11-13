import { Pin, Plus, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import type { Note } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { filterNotes, indexFooter, noteFileName, sortNotes, titleFromFileName } from "../../lib/notes";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { FileInput } from "../primitives/FileInput";
import { Glyph } from "../primitives/Glyph";
import { ListDetail } from "../primitives/ListDetail";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { Panel, PanelEmpty, PanelFilters } from "../primitives/Panel";
import { SearchField } from "../primitives/SearchField";
import { NoteDetail } from "./NoteDetail";
import { NoteEditor } from "./NoteEditor";
import { useNoteDoc } from "./useNoteDoc";

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new" };

/** The id `ListDetail` holds while the new-note form is open, so one column shows it as a detail. */
const NEW_NOTE = "new-note-form";

/**
 * Project notes (M5): Markdown documents the model sees as an index of titles and descriptions. List and detail, as
 * Memory (decision 66, `ListDetail`): side by side from 640px of panel width, one column below. The footer says what the model gets.
 */
export function NotesPanel() {
  const { state, createNote, updateNote, deleteNote } = useProject();
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const now = Date.now();

  const sorted = useMemo(() => sortNotes(state.notes), [state.notes]);
  const shown = useMemo(() => filterNotes(sorted, query), [sorted, query]);
  const selected = state.notes.find((n) => n.id === chosen) ?? null;
  // Wide: the first note is open so the detail is never an empty sentence in a corner. Narrow: nothing is open until chosen.
  const current = mode.kind === "new" ? null : (selected ?? shown[0] ?? null);
  const doc = useNoteDoc(current);

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

  const empty = state.notes.length === 0 && mode.kind !== "new";
  return (
    <div className="h-full min-h-0" data-notes>
      <Panel
        name="notes"
        title="Notes"
        notice={problem ? <Notice tone="error">{problem}</Notice> : undefined}
        actions={
          <>
            <FileInput
              button={{ icon: Upload }}
              label="Import a .md file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onFiles={(files) => files[0] && void importFile(files[0])}
            />
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => setMode({ kind: "new" })} disabled={mode.kind === "new"}>
              New note
            </Button>
          </>
        }
        footer={indexFooter(state.notes)}
      >
        {empty ? (
          <EmptyState title="No notes yet">Decisions and facts saved while working appear here.</EmptyState>
        ) : (
          <ListDetail
            label="Notes"
            listLabel="Notes"
            placeholder="Choose a note to read it."
            selected={mode.kind === "new" ? NEW_NOTE : chosen}
            onSelect={(id) => pick(id === NEW_NOTE ? null : id)}
            listHeader={
              <PanelFilters>
                <SearchField label="Search notes" size="sm" value={query} onChange={setQuery} className="min-w-0 flex-1" />
              </PanelFilters>
            }
            detail={detail}
            list={(select) =>
              shown.length === 0 ? (
                <div role="listitem">
                  <PanelEmpty>No note matches "{query}".</PanelEmpty>
                </div>
              ) : (
                shown.map((n) => <NoteRow key={n.id} note={n} active={current?.id === n.id && mode.kind !== "new"} onPick={() => select(n.id)} />)
              )
            }
          />
        )}
      </Panel>
    </div>
  );
}

function NoteRow(props: { note: Note; active: boolean; onPick(): void }) {
  const { note } = props;
  return (
    <ListRow
      role="listitem"
      size="md"
      selected={props.active}
      title={note.title}
      description={note.description || "No description"}
      meta={
        note.pinned || note.tags.length > 0 ? (
          <span className="inline-flex items-center gap-1">
            {note.pinned && <Glyph icon={Pin} size={14} aria-label="Pinned" />}
            {note.tags.map((t) => `#${t}`).join(" ")}
          </span>
        ) : undefined
      }
      tip={note.description_auto ? "Auto description: taken from the first line of the note" : note.title}
      onClick={props.onPick}
    />
  );
}
