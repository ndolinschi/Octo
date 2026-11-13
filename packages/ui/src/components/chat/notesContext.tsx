import type { ErrorFields } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRequiredContext } from "../../lib/context";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

/** What a slash command leaves in the conversation (B11): small cards and lines after the transcript, never stored. */
export type InlineNote =
  | { id: number; kind: "context" }
  | { id: number; kind: "remembered"; taskId: string; factId: string; text: string; undone: boolean }
  | { id: number; kind: "new-session"; at: string; title: string }
  | { id: number; kind: "help" }
  | { id: number; kind: "info"; text: string }
  | { id: number; kind: "error"; raw: string; code: string | null; fields?: ({ message: string } & ErrorFields) | null };

export type NoteInput = InlineNote extends infer N ? (N extends InlineNote ? Omit<N, "id"> : never) : never;

export type InlineNotesApi = {
  notes: InlineNote[];
  push(note: NoteInput): void;
  dismiss(id: number): void;
  markUndone(factId: string): void;
  /** The conversation's own rewind dialog for the newest request (`/rewind`); absent when the bridge cannot rewind. */
  rewindLast?: (() => void) | undefined;
};

const { Provider, useOptional } = createRequiredContext<InlineNotesApi>("useInlineNotes");
export const useInlineNotes = useOptional;

let next = 0;

/** Owns the notes of one conversation and listens for what the harness says on its own (`fact.remembered`, `conversation.cleared`). */
export function InlineNotesProvider({ rewindLast, children }: { rewindLast?: (() => void) | undefined; children: ReactNode }) {
  const [notes, setNotes] = useState<InlineNote[]>([]);
  const { onEvent } = useProject();
  const { bridge } = useApp();
  const push = useCallback((note: NoteInput) => setNotes((all) => [...all, { ...note, id: (next += 1) }]), []);
  const dismiss = useCallback((id: number) => setNotes((all) => all.filter((n) => n.id !== id)), []);
  const markUndone = useCallback(
    (factId: string) => setNotes((all) => all.map((n) => (n.kind === "remembered" && n.factId === factId ? { ...n, undone: true } : n))),
    [],
  );
  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "fact.remembered") push({ kind: "remembered", taskId: e.task_id, factId: e.fact.id, text: e.fact.text, undone: false });
        if (e.type === "fact.forgotten") markUndone(e.fact_id);
        if (e.type === "conversation.cleared") push({ kind: "new-session", at: e.at, title: e.title });
      }),
    [onEvent, push, markUndone],
  );
  const value = useMemo<InlineNotesApi>(
    () => ({ notes, push, dismiss, markUndone, rewindLast: bridge.rewind ? rewindLast : undefined }),
    [notes, push, dismiss, markUndone, rewindLast, bridge.rewind],
  );
  return <Provider value={value}>{children}</Provider>;
}
