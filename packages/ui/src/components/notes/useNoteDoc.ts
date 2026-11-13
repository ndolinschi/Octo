import type { Note, NoteDocument } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

export type DocLoad = { status: "loading" } | { status: "ok"; doc: NoteDocument } | { status: "error"; message: string };

type Settled = { key: string; load: DocLoad };

/**
 * The body and Markdown source of a note (lists carry neither). Re-read when the note changes; the old body stays on
 * screen meanwhile. State is set from the promise only.
 */
export function useNoteDoc(note: Note | null): DocLoad {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const id = note?.id ?? "";
  const key = `${id}:${note?.updated_at ?? ""}`;
  const [settled, setSettled] = useState<Settled | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const read = bridge.getNote?.(projectId, id) ?? Promise.reject(new Error("this harness cannot open notes"));
    read.then(
      (doc) => !cancelled && setSettled({ key, load: { status: "ok", doc } }),
      (e: unknown) => !cancelled && setSettled({ key, load: { status: "error", message: errorMessage(e) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId, id, key]);
  if (settled?.key === key) return settled.load;
  if (settled?.load.status === "ok" && settled.load.doc.id === id) return settled.load;
  return { status: "loading" };
}
