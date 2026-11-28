import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { errorMessage } from "../../lib/format";
import { ancestors, fileKey, fileName, normalizePath, parentPath } from "../../lib/files";
import { useApp } from "../../state/app";
import { useCode } from "../../state/code";
import { nearestListedAncestor } from "../../state/dirCache";
import { useProject } from "../../state/project";
import { fileTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field } from "../primitives/Field";
import { Notice } from "../primitives/Notice";
import { TextField } from "../primitives/TextField";

export type FileTreeAction =
  | { kind: "new-file"; folder: string; dirPath: string }
  | { kind: "new-folder"; folder: string; dirPath: string }
  | { kind: "rename"; folder: string; path: string; isDir: boolean }
  | { kind: "delete"; folder: string; path: string; isDir: boolean };

function initialValue(action: FileTreeAction): string {
  if (action.kind === "new-file" || action.kind === "new-folder") {
    return action.dirPath ? `${action.dirPath}/` : "";
  }
  return action.path;
}

/** Lazy dialog for creating, renaming, or deleting files and folders from the FileTree context menu. */
export default function FileTreeActionsDialog(props: {
  action: FileTreeAction;
  onOpenFile?: ((folder: string, path: string) => void) | undefined;
  onClose(): void;
}) {
  const { action, onOpenFile, onClose } = props;
  const { bridge } = useApp();
  const { projectId } = useProject();
  const code = useCode();
  const ws = useOptionalWorkspace();
  const fieldId = useId();
  const [value, setValue] = useState(() => initialValue(action));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (action.kind === "rename") {
      // Select only the filename stem (before the last dot) for ergonomic renames.
      const slash = el.value.lastIndexOf("/");
      const start = slash >= 0 ? slash + 1 : 0;
      const dot = action.isDir ? -1 : el.value.lastIndexOf(".");
      const end = dot > start ? dot : el.value.length;
      el.setSelectionRange(start, end);
    } else {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [action]);

  const closeAffectedTabs = (folder: string, path: string, isDir: boolean) => {
    const prefix = `${path}/`;
    for (const f of code.files) {
      if (f.folder !== folder) continue;
      if (f.path === path || (isDir && f.path.startsWith(prefix))) {
        ws?.dropTab(fileTab(f.key));
        code.close(f.key);
      }
    }
  };

  const reloadParent = (folder: string, dirPath: string) => {
    const listed = code.dirs[fileKey(folder, dirPath)];
    if (dirPath && (!listed || listed.entries.length <= 1)) {
      const ancestor = nearestListedAncestor(code.dirs, folder, dirPath);
      if (ancestor) {
        if (code.isExpanded(ancestor.key)) code.reloadDir(folder, ancestor.path, true);
        else code.evictDirs([ancestor.key]);
      }
    }
    code.reloadDir(folder, dirPath);
  };

  const wsOpt = code.workspaceId ? { workspaceId: code.workspaceId } : undefined;
  const wsBody = code.workspaceId ? { workspace_id: code.workspaceId } : {};

  const submit = async (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (busy) return;
    setError(null);

    if (action.kind === "delete") {
      if (!bridge.deleteFile) {
        setError("Deleting files is not supported by this harness version.");
        return;
      }
      setBusy(true);
      try {
        await bridge.deleteFile(projectId, action.folder, action.path, wsOpt);
        closeAffectedTabs(action.folder, action.path, action.isDir);
        reloadParent(action.folder, parentPath(action.path));
        onClose();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    const next = normalizePath(value.trim());
    if (!next) {
      setError(action.kind === "new-folder" ? "Enter a folder path." : "Enter a file path.");
      return;
    }

    setBusy(true);
    try {
      if (action.kind === "new-file") {
        await bridge.writeFile(projectId, { folder: action.folder, path: next, content: "", ...wsBody });
        reloadParent(action.folder, parentPath(next));
        const parents = ancestors(next);
        if (parents.length) code.setExpanded(action.folder, parents, true);
        (onOpenFile ?? code.openFile)(action.folder, next);
      } else if (action.kind === "new-folder") {
        if (!bridge.createDirectory) throw new Error("Creating folders is not supported by this harness version.");
        await bridge.createDirectory(projectId, { folder: action.folder, path: next, ...wsBody });
        reloadParent(action.folder, parentPath(next));
        code.setExpanded(action.folder, [...ancestors(next), next], true);
      } else {
        if (!bridge.renameFile) throw new Error("Renaming files is not supported by this harness version.");
        if (next === action.path) {
          onClose();
          return;
        }
        const wasOpen = !action.isDir && Boolean(code.file(fileKey(action.folder, action.path)));
        await bridge.renameFile(projectId, { folder: action.folder, from: action.path, to: next, ...wsBody });
        closeAffectedTabs(action.folder, action.path, action.isDir);
        const oldDir = parentPath(action.path);
        const newDir = parentPath(next);
        reloadParent(action.folder, oldDir);
        if (newDir !== oldDir) reloadParent(action.folder, newDir);
        if (wasOpen) (onOpenFile ?? code.openFile)(action.folder, next);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (action.kind === "delete") {
    const name = fileName(action.path);
    return (
      <Dialog
        width="sm"
        title={`Delete ${action.isDir ? "folder" : "file"} “${name}”?`}
        description={action.isDir ? `This removes “${action.path}” and everything inside it from disk.` : `This removes “${action.path}” from disk.`}
        onClose={onClose}
        footer={
          <>
            <Button variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void submit()} disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        {error && <Notice tone="error">{error}</Notice>}
      </Dialog>
    );
  }

  const title = action.kind === "new-file" ? "New file" : action.kind === "new-folder" ? "New folder" : action.isDir ? "Rename folder" : "Rename file";
  const cta = action.kind === "rename" ? (busy ? "Renaming…" : "Rename") : busy ? "Creating…" : "Create";
  const label = action.kind === "new-folder" ? "Folder path" : action.kind === "new-file" ? "File path" : "New path";
  const placeholder = action.kind === "new-folder" ? "src/components" : "src/example.ts";

  return (
    <Dialog
      width="sm"
      title={title}
      description={`Inside ${action.folder}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
            {cta}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field label={label} htmlFor={fieldId}>
          <TextField
            ref={inputRef}
            id={fieldId}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Dialog>
  );
}
