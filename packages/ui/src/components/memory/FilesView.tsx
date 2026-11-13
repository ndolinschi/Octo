import type { MemoryFile } from "@octo/agent-client";
import { Pencil, Trash2 } from "lucide-react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { formatDay, formatWhen } from "../../lib/memory/dates";
import { draftProblem, fileDir, fileName, formatBytes, sortFiles } from "../../lib/memory/files";
import type { Load } from "../../lib/memory/load";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Field } from "../primitives/Field";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { ListDetail } from "../primitives/ListDetail";
import { ListRow } from "../primitives/ListRow";
import { Notice } from "../primitives/Notice";
import { DetailHeader } from "../primitives/Panel";
import { SkeletonText } from "../primitives/Skeleton";
import { TextArea, TextField } from "../primitives/TextField";
import { Prose } from "../shared/Prose";
import { ConfirmDialog, DETAIL_MAX, MemoryError, PaneEmpty, ROW_TAIL, RowLine } from "./parts";
import { useMemoryFile } from "./useMemory";

/**
 * Memory files (decision 93 f). Rows: the path (its end kept), the one-line description, size and date at the right. The
 * detail: the file in compact prose, with "Edit" and "Delete" as labelled quiet buttons in its header.
 */
export function FilesView(props: {
  projectId: string;
  load: Load<MemoryFile[]>;
  reload(): void;
  selected: string | null;
  onSelect(path: string | null): void;
}) {
  const files = props.load.status === "ok" ? props.load.value : null;
  const sorted = useMemo(() => (files ? sortFiles(files) : []), [files]);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const current = files?.find((f) => f.path === props.selected) ?? null;
  if (props.load.status === "error") return <MemoryError message={props.load.message} onRetry={props.reload} />;
  if (files && sorted.length === 0)
    return <PaneEmpty title="No memory files">Files the orchestrator writes to remember things between requests appear here.</PaneEmpty>;
  return (
    <ListDetail
      label="Files"
      listLabel="Files"
      placeholder="Choose a file to read or edit it."
      loading={props.load.status === "loading"}
      selected={current?.path ?? null}
      onSelect={(path) => props.onSelect(path)}
      list={(select) =>
        sorted.map((f) => (
          <ListRow
            key={f.path}
            role="listitem"
            size="md"
            selected={f.path === current?.path}
            leading={<Glyph icon={fileIcon(f.path)} size={14} />}
            title={f.path}
            truncate="middle"
            description={<RowLine end={`${formatBytes(f.size)} · ${formatWhen(f.updated_at, now)}`}>{f.summary}</RowLine>}
            tip={f.path}
            onClick={() => select(f.path)}
            trailing={ROW_TAIL}
          />
        ))
      }
      detail={
        current ? (
          <FileDetail
            key={current.path}
            projectId={props.projectId}
            file={current}
            now={now}
            onGone={() => {
              props.onSelect(null);
              props.reload();
            }}
            onSaved={props.reload}
          />
        ) : null
      }
    />
  );
}

function FileDetail(props: { projectId: string; file: MemoryFile; now: number; onGone(): void; onSaved(): void }) {
  const { bridge } = useApp();
  const [revision, setRevision] = useState(0);
  const load = useMemoryFile(props.projectId, props.file.path, revision);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { file, now } = props;
  const remove = bridge.deleteMemoryFile;
  const put = bridge.putMemoryFile;
  return (
    <article aria-label={file.path} className={DETAIL_MAX}>
      <DetailHeader
        title={fileName(file.path)}
        meta={[fileDir(file.path), formatBytes(file.size), `Written ${formatDay(file.updated_at, now)}`].filter(Boolean).join(" · ")}
        {...(editing
          ? {}
          : {
              actions: (
                <>
                  {put && (
                    <Button variant="quiet" size="sm" icon={Pencil} onClick={() => setEditing(true)} disabled={load.status !== "ok"}>
                      Edit
                    </Button>
                  )}
                  {remove && (
                    <Button variant="quiet" size="sm" icon={Trash2} onClick={() => setConfirm(true)}>
                      Delete
                    </Button>
                  )}
                </>
              ),
            })}
      />
      {file.summary && <p className="px-2 pb-2 text-sm break-words text-fg-2">{file.summary}</p>}
      <div className="px-2">
        {load.status === "loading" && <SkeletonText lines={4} className="pt-2" />}
        {load.status === "error" && <MemoryError message={load.message} onRetry={() => setRevision((r) => r + 1)} />}
        {load.status === "ok" &&
          !editing &&
          (load.value.content ? <Prose size="compact" text={load.value.content} /> : <p className="text-sm text-fg-3">The file is empty.</p>)}
        {load.status === "ok" && editing && put && (
          <FileEditor
            file={load.value}
            onCancel={() => setEditing(false)}
            onSave={async (content, summary) => {
              await put.call(bridge, props.projectId, file.path, content, summary);
              setEditing(false);
              setRevision((r) => r + 1);
              props.onSaved();
            }}
          />
        )}
      </div>
      {confirm && remove && (
        <ConfirmDialog
          title="Delete this file?"
          description={`${file.path} leaves the memory index. It will no longer be remembered. This cannot be undone.`}
          confirm="Delete"
          busyText="Deleting"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await remove.call(bridge, props.projectId, file.path);
            props.onGone();
          }}
        />
      )}
    </article>
  );
}

function FileEditor(props: { file: MemoryFile; onCancel(): void; onSave(content: string, summary: string): Promise<void> }) {
  const [content, setContent] = useState(props.file.content ?? "");
  const [summary, setSummary] = useState(props.file.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const summaryProblem = summary.trim() === "" ? "A file needs a one-line summary" : null;
  const textProblem = draftProblem(content);
  const problem = textProblem ?? summaryProblem;
  const dirty = content !== (props.file.content ?? "") || summary !== props.file.summary;
  const [discarding, setDiscarding] = useState(false);
  const lastField = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Esc and Cancel close at once when nothing changed; otherwise they ask first, in the action row.
  const cancel = () => {
    if (!dirty) return props.onCancel();
    setDiscarding(true);
    requestAnimationFrame(() => keepRef.current?.focus());
  };
  const keepEditing = () => {
    setDiscarding(false);
    requestAnimationFrame(() => (lastField.current?.isConnected ? lastField.current : first.current)?.focus());
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(content, summary.trim());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3 pt-4"
      onFocus={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) lastField.current = e.target;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (discarding) keepEditing();
          else if (!busy) cancel();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && dirty && !busy) void save();
      }}
    >
      <Field
        label="Summary"
        htmlFor={`${id}-s`}
        hint={summaryProblem ? undefined : "One line; it shows in the memory index."}
        error={summaryProblem}
        errorId={`${id}-se`}
      >
        <TextField
          id={`${id}-s`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          ref={first}
          aria-invalid={summaryProblem ? true : undefined}
          aria-describedby={summaryProblem ? `${id}-se` : undefined}
        />
      </Field>
      <Field label="Text" htmlFor={`${id}-c`} error={textProblem} errorId={`${id}-e`}>
        <TextArea
          id={`${id}-c`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          spellCheck={false}
          aria-invalid={textProblem ? true : undefined}
          aria-describedby={textProblem ? `${id}-e` : undefined}
          className="font-mono text-xs"
        />
      </Field>
      {error && <Notice tone="error">Could not save the file: {error}. Your text is still here; save again.</Notice>}
      {discarding ? (
        <div key="discard" role="alertdialog" aria-label="Discard changes" className="flex flex-wrap items-center justify-end gap-2 text-sm">
          <span className="min-w-0 flex-1 text-fg-2">Discard changes?</span>
          <Button variant="quiet" ref={keepRef} onClick={keepEditing}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={props.onCancel}>
            Discard
          </Button>
        </div>
      ) : (
        <div key="actions" className="flex items-center justify-end gap-2">
          <Button variant="quiet" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!!problem || !dirty}>
            {busy ? "Saving" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
