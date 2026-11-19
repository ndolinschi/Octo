import { Pin, Plus, Upload } from "lucide-react";
import { useQuietOpen } from "../../lib/quietFocus";
import { useListStops } from "../../lib/listStops";
import { useMemo, useState, useRef } from "react";
import type { Note } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import { formatDay } from "../../lib/memory/dates";
import { filterNotes, indexFooter, noteFileName, noteLine, sortNotes, titleFromFileName } from "../../lib/notes";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
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
import { PanelPurpose } from "../shared/PanelPurpose";

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
  // B4.3: focus the dock moves here on opening draws no ring until the first key or press.
  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  // Item 9 (polish pass F3): the notes are one Tab stop (↑/↓/Home/End between them), a list of items (axe: a button cannot be one).
  const noteList = useRef<HTMLUListElement>(null);
  useListStops(noteList);
  return (
    <div ref={quiet} className="h-full min-h-0" data-notes>
      <Panel
        name="notes"
        title="Notes"
        lead={<PanelPurpose tool="notes" />}
        notice={problem ? <Notice tone="error">{problem}</Notice> : undefined}
        actions={
          <>
            <FileInput
              button={{ icon: Upload }}
              label="Import a .md file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onFiles={(files) => files[0] && void importFile(files[0])}
            />
            {/* R2: quiet, so its label ends on the rows' text edge (a framed button added a third right edge to the panel). */}
            <Button variant="quiet" size="sm" icon={Plus} onClick={() => setMode({ kind: "new" })} disabled={mode.kind === "new"}>
              New note
            </Button>
          </>
        }
        // An empty project has nothing to index: no footer then (B4).
        {...(state.notes.length > 0 ? { footer: <NotesFooter notes={state.notes} /> } : {})}
      >
        {empty ? (
          <PanelEmpty title="No notes yet">Decisions and facts saved while working appear here, and agents read them when they are relevant.</PanelEmpty>
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
            detailFills={mode.kind === "new" || (mode.kind === "edit" && doc.status === "ok")}
            listSemantics="own"
            list={(select) =>
              shown.length === 0 ? (
                <PanelEmpty>No note matches "{query}".</PanelEmpty>
              ) : (
                <ul ref={noteList} aria-label="Notes" className="flex flex-col gap-1.5">
                  {shown.map((n) => (
                    <li key={n.id}>
                      <NoteRow note={n} now={now} active={current?.id === n.id && mode.kind !== "new"} onPick={() => select(n.id)} />
                    </li>
                  ))}
                </ul>
              )
            }
          />
        )}
      </Panel>
    </div>
  );
}

/**
 * P3 (polish step 5): the anatomy of every tool list. A 16px glyph column (the pin of a pinned note), the title, and a dim
 * second line: the description with its tags after it (they give way, never the title), the date at the right.
 */
function NoteRow(props: { note: Note; now: number; active: boolean; onPick(): void }) {
  const { note } = props;
  const line = noteLine(note);
  return (
    <ListRow
      size="md"
      selected={props.active}
      // The glyph column holds the pin only: a notebook on every row was noise, an empty slot keeps the text edge.
      leading={note.pinned ? <Glyph icon={Pin} size={14} /> : null}
      title={
        <>
          {note.pinned && <span className="sr-only">Pinned: </span>}
          {note.title}
        </>
      }
      description={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{line}</span>
          <span className="shrink-0 tabular-nums">{formatDay(note.updated_at, props.now)}</span>
        </span>
      }
      tip={note.description_auto ? "Auto description: taken from the first line of the note" : note.title}
      onClick={props.onPick}
    />
  );
}

/** The index line in plain words; the counts are its tooltip (walk B13). */
function NotesFooter({ notes }: { notes: Parameters<typeof indexFooter>[0] }) {
  const { text, tip } = indexFooter(notes);
  return <span title={tip}>{text}</span>;
}
