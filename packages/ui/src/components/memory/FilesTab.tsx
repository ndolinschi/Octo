import type { MemoryFile } from "@octo/agent-client";
import { FileText, Pencil, Trash2 } from "lucide-react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage, formatRelative } from "../../lib/format";
import { draftProblem, fileDir, fileName, formatBytes, sortFiles } from "../../lib/memory/files";
import type { Load } from "../../lib/memory/load";
import { formatDay } from "../../lib/memory/tasks";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field, Input, Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { Markdown } from "../shared/Markdown";
import { Block, DetailTitle, Empty, ErrorState, ListDetail, ListRow, Loading, RowList } from "./parts";
import { useMemoryFile } from "./useMemory";

/** Memory files: the list, a rendered view, an editor (path stays, summary and text change) and delete with a confirm. */
export function FilesTab(props: { projectId: string; load: Load<MemoryFile[]>; reload(): void; selected: string | null; onSelect(path: string | null): void }) {
  const files = props.load.status === "ok" ? props.load.value : null;
  const sorted = useMemo(() => (files ? sortFiles(files) : []), [files]);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const current = files?.find((f) => f.path === props.selected) ?? null;
  if (props.load.status === "loading") return <Loading />;
  if (props.load.status === "error") return <ErrorState message={props.load.message} onRetry={props.reload} />;
  if (sorted.length === 0) return <Empty title="No memory files">Files the orchestrator writes to remember things between requests appear here.</Empty>;
  return (
    <ListDetail
      label="Files"
      listLabel="Files"
      placeholder="Choose a file to read or edit it."
      onBack={() => props.onSelect(null)}
      listHeader={
        <p className="flex h-row shrink-0 items-center px-4 text-xs text-fg-3">
          {sorted.length} {sorted.length === 1 ? "file" : "files"}, most recent first
        </p>
      }
      list={
        <RowList label="Memory files">
          {sorted.map((f) => (
            <ListRow
              key={f.path}
              selected={f.path === props.selected}
              onClick={() => props.onSelect(f.path)}
              leading={<Glyph icon={FileText} size={14} />}
              label={<span title={f.path}>{f.path}</span>}
              trailing={formatRelative(f.updated_at, now)}
            />
          ))}
        </RowList>
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
    <article aria-label={file.path}>
      <DetailTitle
        title={fileName(file.path)}
        actions={
          !editing && (
            <span className="-mr-1.5 flex shrink-0 gap-0.5">
              {put && <IconButton icon={Pencil} label="Edit file" onClick={() => setEditing(true)} disabled={load.status !== "ok"} />}
              {remove && <IconButton icon={Trash2} label="Delete file" onClick={() => setConfirm(true)} />}
            </span>
          )
        }
      >
        {fileDir(file.path) && <span className="font-mono">{fileDir(file.path)}</span>}
        <span>{formatBytes(file.size)}</span>
        <span>Written {formatDay(file.updated_at, now)}</span>
      </DetailTitle>
      {file.summary && <p className="pt-2 text-sm break-words text-fg-2">{file.summary}</p>}
      {load.status === "loading" && <Loading rows={4} />}
      {load.status === "error" && <ErrorState message={load.message} onRetry={() => setRevision((r) => r + 1)} />}
      {load.status === "ok" && !editing && (
        <Block title="Content">{load.value.content ? <Markdown text={load.value.content} /> : <p className="text-sm text-fg-3">The file is empty.</p>}</Block>
      )}
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
      {confirm && remove && (
        <DeleteDialog
          path={file.path}
          onClose={() => setConfirm(false)}
          onDelete={async () => {
            await remove.call(bridge, props.projectId, file.path);
            setConfirm(false);
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
  const problem = draftProblem(content) ?? (summary.trim() === "" ? "A file needs a one-line summary" : null);
  const dirty = content !== (props.file.content ?? "") || summary !== props.file.summary;
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
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && dirty && !busy) void save();
      }}
    >
      <Field label="Summary" htmlFor={`${id}-s`} hint="One line; the orchestrator sees it in the memory index.">
        <Input id={`${id}-s`} value={summary} onChange={(e) => setSummary(e.target.value)} ref={first} />
      </Field>
      <Field label="Text" htmlFor={`${id}-c`} error={problem && summary.trim() !== "" ? problem : null} errorId={`${id}-e`}>
        <Textarea
          id={`${id}-c`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          spellCheck={false}
          aria-describedby={`${id}-e`}
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onCancel();
            }
          }}
        />
      </Field>
      {error && (
        <p role="alert" className="text-xs text-err">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !!problem || !dirty}>
          {busy ? "Saving" : "Save"}
        </Button>
        <Button variant="ghost" onClick={props.onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeleteDialog(props: { path: string; onClose(): void; onDelete(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="Delete this file?"
      description={`${props.path} leaves the memory index. The orchestrator will no longer see it. This cannot be undone.`}
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              props.onDelete().catch((e: unknown) => {
                setError(errorMessage(e));
                setBusy(false);
              });
            }}
          >
            {busy ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
    </Dialog>
  );
}
