import { useState } from "react";
import { errorMessage } from "../../lib/format";
import { OCTO_FALLBACK } from "../../lib/slash";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useTabFlags } from "../../state/tabFlags";
import { Button } from "../primitives/Button";
import { Card } from "../primitives/Card";
import { Notice } from "../primitives/Notice";
import { ContextReport } from "./ContextReport";
import { ErrorNotice } from "../shared/ErrorNotice";
import { useInlineNotes, type InlineNote } from "./notesContext";
import { useAgentName } from "./agentName";

/** The lines and cards slash commands leave under the transcript (B11); its own chunk, mounted once something exists. */
export function InlineNotes() {
  const api = useInlineNotes();
  if (!api || api.notes.length === 0) return null;
  return (
    <div data-inline-notes className="mt-4 flex flex-col gap-4">
      {api.notes.map((n) => (
        <Note key={n.id} note={n} />
      ))}
    </div>
  );
}

function Note({ note }: { note: InlineNote }) {
  const api = useInlineNotes();
  const { project, state } = useProject();
  const orchestrator = project?.orchestrator_agent_id ? state.agents[project.orchestrator_agent_id] : undefined;
  const agent = useAgentName(orchestrator?.model);
  switch (note.kind) {
    case "context":
      return <ContextReport onClose={() => api?.dismiss(note.id)} />;
    case "remembered":
      return <Remembered note={note} />;
    case "new-session":
      return (
        <div data-new-session role="separator" aria-label="New session" className="flex h-4 items-center gap-3 text-xs text-fg-3" title={note.title}>
          <span aria-hidden className="h-px flex-1 bg-line" />
          New session started
          <span aria-hidden className="h-px flex-1 bg-line" />
        </div>
      );
    case "help":
      return <Help onClose={() => api?.dismiss(note.id)} />;
    case "info":
      return <Notice tone="info">{note.text}</Notice>;
    case "error":
      return (
        <ErrorNotice
          className="-mx-3"
          fields={note.fields}
          raw={note.raw}
          code={note.code}
          agent={agent}
          actions={
            <Button size="sm" variant="quiet" onClick={() => api?.dismiss(note.id)}>
              Dismiss
            </Button>
          }
        />
      );
  }
}

/** "Remembered: …" with Undo (`forgetFact`); quiet, one line. */
function Remembered({ note }: { note: Extract<InlineNote, { kind: "remembered" }> }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const api = useInlineNotes();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const undo = async () => {
    if (!bridge.forgetFact) return;
    setBusy(true);
    setProblem(null);
    try {
      await bridge.forgetFact(projectId, note.taskId, note.factId);
      api?.markUndone(note.factId);
    } catch (e) {
      setProblem(`Could not undo: ${errorMessage(e)}. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-remembered className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-fg-3">
      <span className="min-w-0 truncate" title={note.text}>
        {note.undone ? "Forgotten: " : "Remembered: "}
        {note.text}
      </span>
      {!note.undone && bridge.forgetFact && (
        <Button variant="quiet" size="xs" loading={busy} disabled={busy} onClick={() => void undo()}>
          Undo
        </Button>
      )}
      {problem && <Notice tone="error">{problem}</Notice>}
    </div>
  );
}

function Help({ onClose }: { onClose(): void }) {
  const tabFlags = useTabFlags();
  const always = OCTO_FALLBACK.filter((c) => c.name !== "memory" || tabFlags.memory);
  return (
    <section data-help aria-label="Commands" className="-mx-3 text-sm">
      <Card
        header={
          <>
            <h3 className="min-w-0 flex-1 truncate text-heading text-fg">Commands</h3>
            <Button variant="quiet" size="xs" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        <p className="text-fg-2">
          Type <code className="font-mono text-xs text-fg">/</code> to see commands. Octo&apos;s commands run here; the agent&apos;s own are sent as typed.{" "}
          <code className="font-mono text-xs text-fg">/new</code> with text starts a new session and sends the text there.
        </p>
        <p className="mt-2 text-xs text-fg-3">Always available: {always.map((c) => `/${c.name}`).join(", ")}.</p>
      </Card>
    </section>
  );
}
