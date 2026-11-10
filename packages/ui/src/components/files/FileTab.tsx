import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { splitKey } from "../../lib/files";
import { middleTruncate } from "../../lib/format";
import { useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useCode, type OpenFile } from "../../state/code";
import { Button } from "../primitives/Button";
import { Spinner } from "../primitives/Status";
import { CodeEditor } from "./CodeEditor";

/**
 * One open file: a slim header (path; its right slot is where editor actions go), a notice line
 * when the disk and the buffer disagree, then the editor or a one-line explanation.
 */
export function FileTab({ fileKey }: { fileKey: string }) {
  const code = useCode();
  const { theme } = useApp();
  const file = code.file(fileKey);
  const { folder, path } = splitKey(fileKey);
  const opening = useDelayedLoading(!file || file.status === "loading");
  const saving = useDelayedLoading(Boolean(file?.saving));

  // Ctrl/Cmd+S anywhere in the tab (Monaco binds it too; saving is guarded against doubles).
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (file) void code.save(file.key);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex h-8 shrink-0 items-center gap-3 border-b border-line pr-2 pl-3 text-xs text-fg-3">
        <PathCrumbs folder={folder} path={path} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5" role="status">
          {saving && (
            <>
              <Spinner size={10} /> Saving…
            </>
          )}
          {file?.modified && !saving && <span>Unsaved</span>}
        </span>
      </header>
      {file && <Notice file={file} />}
      <div className="min-h-0 flex-1">
        {file?.status === "ready" && !opening ? (
          <CodeEditor file={file} buffers={code.buffers} theme={theme} onSave={() => void code.save(file.key)} />
        ) : (
          <Message file={file} name={path.slice(path.lastIndexOf("/") + 1)} showLoading={opening} />
        )}
      </div>
    </div>
  );
}

function PathCrumbs({ folder, path }: { folder: string; path: string }) {
  const parts = [folder, ...path.split("/")];
  return (
    <p className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap" title={middleTruncate(`${folder}/${path}`, 96)}>
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden>/</span>}
            <span className={cn(last ? "min-w-0 shrink truncate text-fg-2" : "max-w-[160px] min-w-[2ch] shrink-[8] truncate")}>{p}</span>
          </Fragment>
        );
      })}
    </p>
  );
}

function Message({ file, name, showLoading }: { file: OpenFile | undefined; name: string; showLoading: boolean }) {
  const code = useCode();
  if (showLoading || !file || file.status === "loading" || file.status === "ready") {
    if (!showLoading) return null;
    return (
      <p className="flex items-center gap-2 px-3 pt-3 text-sm text-fg-3">
        <Spinner /> Opening {name}…
      </p>
    );
  }
  const text =
    file.status === "too_large"
      ? "This file is larger than 2 MiB, too large to open here."
      : file.status === "binary"
        ? "This is a binary file, so it can't be shown as text."
        : `Couldn't open this file: ${(file.error ?? "unknown error").replace(/\.$/, "")}.`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-3 text-sm text-fg-2">
      <p className={cn("min-w-0", file.status === "error" && "text-err")}>{text}</p>
      {file.status === "error" && (
        <Button size="sm" onClick={() => code.retryOpen(file.key)}>
          Retry
        </Button>
      )}
    </div>
  );
}

function Notice({ file }: { file: OpenFile }) {
  const code = useCode();
  const n = file.notice;
  if (!n) return null;
  let text: ReactNode;
  let actions: ReactNode;
  if (n.kind === "conflict") {
    text = "Changed on disk since you opened it.";
    actions = (
      <>
        <Button size="sm" onClick={() => void code.reloadFromDisk(file.key)}>
          Reload from disk
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void code.save(file.key, { overwrite: true })}>
          Overwrite
        </Button>
      </>
    );
  } else if (n.kind === "changed") {
    text = "Changed on disk.";
    actions = (
      <>
        <Button size="sm" onClick={() => void code.reloadFromDisk(file.key)}>
          Reload
        </Button>
        <Button size="sm" variant="ghost" onClick={() => code.dismissNotice(file.key)}>
          Keep mine
        </Button>
      </>
    );
  } else {
    text = <span className="text-err">Couldn't save: {n.message.replace(/\.$/, "")}.</span>;
    actions = (
      <Button size="sm" onClick={() => void code.save(file.key)}>
        Retry
      </Button>
    );
  }
  return (
    <div
      role={n.kind === "save_error" || n.kind === "conflict" ? "alert" : "status"}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5 text-sm text-fg-2"
    >
      <span className="min-w-0 flex-1 basis-48">{text}</span>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </div>
  );
}
