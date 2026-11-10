import { FolderTree, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { readPref, writePref } from "../../lib/storage";
import { useApp } from "../../state/app";
import { useCode, type OpenFile } from "../../state/code";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Status";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";

/** Below this pane width the tree and the editor take turns instead of sitting side by side. */
const SPLIT_MIN = 600;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function FilesPanel(props: { surface: "docked" | "overlay"; onSettings(): void }) {
  const code = useCode();
  const { theme } = useApp();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [treeHidden, setTreeHidden] = useState(() => readPref("filesTree") === "hidden");
  const [confirm, setConfirm] = useState<OpenFile | null>(null);
  const { folders, files, active } = code;
  const split = width >= SPLIT_MIN;

  // Ctrl/Cmd+S anywhere in the panel (the editor binds it too; saving is guarded against doubles).
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (active) void code.save(active.key);
    }
  };

  const requestClose = (f: OpenFile) => (f.modified ? setConfirm(f) : code.close(f.key));

  if (!folders.length) {
    return (
      <div className="px-4 pt-3 text-sm">
        <p className="text-fg-2">No folders attached. Add one in project settings.</p>
        <Button size="sm" className="mt-3" onClick={props.onSettings}>
          Project settings
        </Button>
      </div>
    );
  }

  const tree = <FileTree folders={folders} />;
  const treeShown = split ? !treeHidden : code.view === "tree";
  const toggleTree = () => {
    if (!split) return code.setView(code.view === "tree" ? "editor" : "tree");
    setTreeHidden((h) => {
      writePref("filesTree", h ? "shown" : "hidden");
      return !h;
    });
  };

  return (
    <div ref={ref} className="flex h-full min-h-0" onKeyDown={onKeyDown}>
      {!files.length ? (
        <div className="min-w-0 flex-1">{tree}</div>
      ) : (
        <>
          {split && treeShown && <div className="w-[220px] shrink-0 border-r border-line">{tree}</div>}
          <div className="flex min-w-0 flex-1 flex-col">
            <TabStrip
              leading={
                <IconButton
                  icon={split ? (treeShown ? PanelLeftClose : PanelLeftOpen) : FolderTree}
                  label={split ? (treeShown ? "Hide file tree" : "Show file tree") : treeShown ? "Show editor" : "Show file tree"}
                  pressed={!split && treeShown}
                  aria-expanded={split ? treeShown : undefined}
                  onClick={toggleTree}
                />
              }
              onClose={requestClose}
            />
            {!split && treeShown ? (
              <div className="min-h-0 flex-1">{tree}</div>
            ) : (
              active && <EditorBody file={active} theme={theme} surface={props.surface} />
            )}
          </div>
        </>
      )}
      {confirm && (
        <Dialog
          width="sm"
          title={`Discard changes to ${confirm.name}?`}
          description="Your edits haven't been saved and will be lost."
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)} data-autofocus>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  code.close(confirm.key);
                  setConfirm(null);
                }}
              >
                Discard changes
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </div>
  );
}

function TabStrip({ leading, onClose }: { leading: ReactNode; onClose(file: OpenFile): void }) {
  const code = useCode();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const { files, activeKey } = code;

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    if (activeKey) refs.current.get(activeKey)?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const move = (j: number) => {
      const f = files[(j + files.length) % files.length];
      code.activate(f.key);
      refs.current.get(f.key)?.focus();
    };
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(i + 1),
      ArrowLeft: () => move(i - 1),
      Home: () => move(0),
      End: () => move(files.length - 1),
      Delete: () => onClose(files[i]),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-2 pl-1.5">
      {leading}
      <div role="tablist" aria-label="Open files" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {files.map((f, i) => {
          const selected = f.key === activeKey;
          return (
            <div
              key={f.key}
              className={cn(
                "group relative flex h-7 max-w-[200px] min-w-0 shrink-0 items-center rounded-sm transition-[background-color,color] duration-100",
                selected ? "bg-raised text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2",
              )}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(f);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
            >
              <button
                ref={(el) => {
                  if (el) refs.current.set(f.key, el);
                  else refs.current.delete(f.key);
                }}
                type="button"
                role="tab"
                id={`file-tab-${i}`}
                aria-selected={selected}
                aria-controls="file-editor"
                tabIndex={selected ? 0 : -1}
                title={`${f.folder}/${f.path}${f.modified ? " (unsaved)" : ""}`}
                onClick={() => code.activate(f.key)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="flex h-full min-w-0 items-center rounded-sm pr-1 pl-2.5 text-sm focus-visible:-outline-offset-2"
              >
                <span className="min-w-0 truncate">{f.name}</span>
                {f.modified && <span className="sr-only"> (unsaved)</span>}
              </button>
              <span className="relative mr-1 grid size-5 shrink-0 place-items-center">
                {f.modified && (
                  <span
                    aria-hidden
                    data-testid="modified-dot"
                    className="size-2 rounded-full bg-fg-2 group-focus-within:invisible group-hover:invisible"
                  />
                )}
                <button
                  type="button"
                  tabIndex={selected ? 0 : -1}
                  aria-label={`Close ${f.name}`}
                  title={`Close ${f.name}`}
                  onClick={() => onClose(f)}
                  className={cn(
                    "absolute inset-0 grid place-items-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg focus-visible:opacity-100",
                    f.modified ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" : selected ? "" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditorBody({ file, theme, surface }: { file: OpenFile; theme: "dark" | "light"; surface: "docked" | "overlay" }) {
  const code = useCode();
  return (
    <div id="file-editor" role="tabpanel" aria-label={file.name} className="flex min-h-0 flex-1 flex-col">
      <Notice file={file} />
      <div className="min-h-0 flex-1">
        {file.status === "ready" ? (
          <CodeEditor file={file} buffers={code.buffers} theme={theme} surface={surface} onSave={() => void code.save(file.key)} />
        ) : (
          <Message file={file} />
        )}
      </div>
    </div>
  );
}

function Message({ file }: { file: OpenFile }) {
  const code = useCode();
  if (file.status === "loading") {
    return (
      <p className="flex items-center gap-2 px-3 pt-3 text-sm text-fg-3">
        <Spinner /> Opening {file.name}…
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
  if (!n && !file.saving) return null;
  let text: ReactNode;
  let actions: ReactNode = null;
  if (!n) {
    text = (
      <span className="flex items-center gap-2 text-fg-3">
        <Spinner size={10} /> Saving…
      </span>
    );
  } else if (n.kind === "conflict") {
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
        <IconButton icon={X} size="sm" label="Keep my version" onClick={() => code.dismissNotice(file.key)} />
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
      role={n?.kind === "save_error" || n?.kind === "conflict" ? "alert" : "status"}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5 text-sm text-fg-2"
    >
      <span className="min-w-0 flex-1 basis-48">{text}</span>
      {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
    </div>
  );
}
