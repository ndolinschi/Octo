import { ArrowLeft, ArrowRight, ChevronRight, Ellipsis, PanelLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { Fragment, lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { fileKey as fileKeyOf, splitKey, type FileKey } from "../../lib/files";
import { middleTruncate } from "../../lib/format";
import { crumbName, fitCrumbs } from "../../lib/crumbs";
import { useCopy, useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useCode, type OpenFile } from "../../state/code";
import { useProject } from "../../state/project";
import { fileTab, type TabId } from "../../state/workspace/layout";
import { focusSoon } from "../../lib/focus";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useFloatingHere } from "../../state/workspace/useFloatingHere";
import { useGroup } from "../../state/workspace/group";
import { domId } from "../../state/workspace/ids";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { EditorSkeleton } from "./EditorSkeleton";
import { CodeEditor } from "./CodeEditor";
import { EditorStatus } from "./EditorStatus";
import { CompletionStatus } from "./editor/completion/CompletionStatus";
import { fileIcon, isMarkdown } from "../primitives/fileIcons";
/** The Markdown preview loads with the first Markdown file (its own chunk). */
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })));
import { TreeColumn } from "./TreeColumn";
import { useTreeShell } from "./useTreeShell";
import { slot } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";

/** Renders the floating composer over the editor area; `onHeight` reports the room it takes. Supplied by the dock. */
export type FloatingSlot = (onHeight: (px: number) => void) => ReactNode;

/** Gap between the floating composer and the last line it must not cover (contract v6 decision 8). */
const FLOAT_ROOM = 16;

type Mode = "preview" | "source";
const MD_MODE = slot("md", (v): v is Mode => v === "preview" || v === "source");

/**
 * A file view: every File tab, and the Files tab while no file is open. One 40px breadcrumb row
 * (back / forward, crumbs, then status, Preview|Source for Markdown, a `…` menu and the tree toggle),
 * the editor edge to edge below it, and the tree column at the left edge (decision 94a; width and shown/hidden per group).
 * A group too narrow for the column and a 360px editor shows the tree as a page instead (`useTreeShell`). When no Chat tab
 * is visible, the focused file view shows the floating composer over its editor area (never over the tree).
 */
export function FileView({ tab, fileKey, floatingComposer }: { tab: TabId; fileKey: FileKey | null; floatingComposer: FloatingSlot }) {
  const code = useCode();
  const group = useGroup();
  const { project } = useProject();
  const { theme } = useApp();
  const file = fileKey ? code.file(fileKey) : undefined;
  const { folder, path } = fileKey ? splitKey(fileKey) : { folder: "", path: "" };
  const markdown = fileKey !== null && isMarkdown(path);
  const [mode, setMode] = useTabMemory(tab, MD_MODE, "preview");
  const floating = useFloatingHere(tab);
  const [floatHeight, setFloatHeight] = useState(0);
  const bottomRoom = floating && floatHeight > 0 ? floatHeight + FLOAT_ROOM : 0;
  const opening = useDelayedLoading(fileKey !== null && (!file || file.status === "loading"));
  const saving = useDelayedLoading(Boolean(file?.saving));

  const groupId = group?.groupId ?? "";
  const root = useRef<HTMLDivElement>(null);
  const shell = useTreeShell(root, tab, fileKey, groupId);
  const { width, page, showEditor } = shell;
  const treeId = `${domId(tab)}-tree`;
  // Files picked in this view's tree open in this group; the empty view turns into the file in place. In page mode the picked
  // file also turns the page to the editor (one change, nothing else moves). Opening a file never leaves focus on nothing:
  // when the picked row went away (the tree page hid, the empty Files view turned into the file in place), the file's editor
  // or preview takes it.
  const openHere = useCallback(
    (f: string, p: string) => {
      showEditor();
      code.openFile(f, p, undefined, group ? (fileKey ? { group: group.groupId } : { group: group.groupId, replace: tab }) : undefined);
      const panel = `${domId(fileTab(fileKeyOf(f, p)))}-panel`;
      focusSoon(
        () => {
          const el = document.getElementById(panel);
          const input = [...(el?.querySelectorAll<HTMLElement>(".monaco-editor textarea") ?? [])].find((t) => t.closest("[inert]") === null);
          return input ?? el?.querySelector<HTMLElement>("[data-file-focus]");
        },
        { onlyIfLost: true, timeout: 1500 },
      );
    },
    [code, group, fileKey, tab, showEditor],
  );

  // Ctrl/Cmd+S anywhere in the view (Monaco binds it too; saving is guarded against doubles).
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (file) void code.save(file.key);
    }
  };

  // Decision 85: the editor is one Monaco instance for every file this view shows (it swaps models), mounted with the first file;
  // whatever stands in for it (the empty view, the loading skeleton, a message, the Markdown preview) is a cover over the same
  // box. `shown` is the last file that was ready: the model the editor keeps until the next one is.
  const [shown, setShown] = useState<OpenFile | null>(null);
  if (file?.status === "ready" && file !== shown) setShown(file);
  const ready = file?.status === "ready" && !opening;
  let cover: ReactNode = null;
  if (!fileKey) {
    cover = <div className="grid h-full place-items-center text-sm text-fg-3">{code.folders.length ? "Select a file" : <NoFolders />}</div>;
  } else if (!ready) {
    cover = <Message file={file} name={path.slice(path.lastIndexOf("/") + 1)} showLoading={opening} />;
  } else if (markdown && mode === "preview") {
    cover = (
      <Suspense fallback={null}>
        <MarkdownPreview file={file} bottomRoom={bottomRoom} onOpen={openHere} />
      </Suspense>
    );
  }
  const body = (
    <div className="relative h-full min-h-0">
      {fileKey !== null && (
        <div className="absolute inset-0" inert={cover !== null}>
          <CodeEditor
            file={shown}
            buffers={code.buffers}
            theme={theme}
            bottomPadding={Math.max(8, bottomRoom)}
            onSave={() => void (shown && code.save(shown.key))}
            onMonaco={(mod) => code.startIntel((o) => new mod.LspManager({ ...o, monaco: mod.monaco }))}
          />
        </div>
      )}
      {cover && <div className="absolute inset-0 z-10 bg-panel">{cover}</div>}
    </div>
  );

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {/* The hairline is an inset shadow, so the 40px row keeps a 40px content box (no half-pixel centring). */}
      <div data-file-bar className="flex h-bar shrink-0 items-center gap-1 px-2 text-xs text-fg-3 shadow-[inset_0_-1px_0_var(--octo-line)]">
        {page && !shell.treePage && fileKey && (
          <Button variant="quiet" size="sm" icon={PanelLeft} title="Show the file tree" onClick={shell.showTree}>
            Files
          </Button>
        )}
        <IconButton icon={ArrowLeft} label="Back" title="Back (previous file in this group)" disabled={!group?.canBack} onClick={group?.back} />
        <IconButton icon={ArrowRight} label="Forward" title="Forward (next file in this group)" disabled={!group?.canForward} onClick={group?.forward} />
        {fileKey ? <Crumbs folder={folder} path={path} /> : <p className="ml-1 min-w-0 flex-1 truncate px-1 text-sm text-fg-2">{project?.name}</p>}
        <span className="flex shrink-0 items-center gap-2 pl-2">
          <span className="flex shrink-0 items-center gap-2 empty:hidden" role="status">
            {saving && (
              <>
                <Spinner size={10} /> Saving…
              </>
            )}
            {file?.modified && !saving && <span>Unsaved</span>}
          </span>
          {fileKey && <CompletionStatus fileKey={fileKey} compact={width > 0 && width < 640} />}
          {fileKey && (
            <EditorStatus
              compact={width > 0 && width < 640}
              intel={code.intel}
              fileKey={fileKey}
              onJump={(p) => code.openFile(folder, path, { line: p.line, column: p.column })}
            />
          )}
        </span>
        {markdown && file?.status === "ready" && <ModeToggle mode={mode} onChange={setMode} />}
        {fileKey && <MoreMenu tab={tab} folder={folder} path={path} />}
        {page ? (
          shell.treePage &&
          fileKey && (
            <Button variant="quiet" size="sm" onClick={shell.showEditor}>
              Editor
            </Button>
          )
        ) : (
          <IconButton
            icon={shell.open ? PanelLeftClose : PanelLeftOpen}
            label={shell.open ? "Hide file tree" : "Show file tree"}
            aria-expanded={shell.open}
            aria-controls={shell.open ? treeId : undefined}
            onClick={shell.toggleColumn}
            className={cn(shell.open && "text-fg-2")}
          />
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        {(page || shell.open) && (
          <TreeColumn
            key="tree"
            id={treeId}
            tab={tab}
            page={page}
            shown={!page || shell.treePage}
            width={shell.column}
            maxWidth={shell.maxWidth}
            groupId={groupId}
            onOpenFile={openHere}
          />
        )}
        <div
          key="editor"
          data-editor-area
          inert={page && shell.treePage}
          className={cn(
            "relative flex min-w-0 flex-1 flex-col overflow-clip contain-inline-size",
            page && "absolute inset-0",
            page && shell.treePage && "invisible",
          )}
        >
          {file && <Notice file={file} />}
          <div className="min-h-0 flex-1">{body}</div>
          {floating && floatingComposer(setFloatHeight)}
        </div>
      </div>
    </div>
  );
}

function NoFolders() {
  const ws = useWorkspace();
  return (
    <div className="text-center">
      <p className="text-fg-2">No folders attached. Add one in project settings.</p>
      <Button size="sm" className="mt-3" onClick={ws.openSettings}>
        Project settings
      </Button>
    </div>
  );
}

/** Canvas text measurer for the crumbs (one context, reused). */
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Crumb padding (px-1 both sides), the separator glyph, the gap between items, the file crumb's icon + gap. */
const CRUMB_PAD = 8;
const SEP = 14;
const GAP = 2;
const FILE_CHROME = CRUMB_PAD + 14 + 8;

/**
 * `folder › dir › file`: a folder or directory crumb reveals it in the tree; the file crumb carries its icon. The row
 * collapses by measured fit (`lib/crumbs.ts`): everything, then `folder › … › parent › file`, `… › parent › file`,
 * `… › file`; the "…" crumb is a menu of what it hides. The file name is shortened once (in the middle) only when it
 * alone does not fit. The crumbs take the room the status and the buttons leave; they never push into them.
 */
function Crumbs({ folder, path }: { folder: string; path: string }) {
  const code = useCode();
  const nav = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<{ width: number; font: string } | null>(null);
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth, font: getComputedStyle(el).font || "13px sans-serif" });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const all = path.split("/");
  const name = all.pop() ?? path;
  const plan = useMemo(() => {
    if (!room) return { folder: true, dirs: all.map((_, i) => i), hidden: [], nameChars: null };
    const t = (x: string) => Math.ceil(textWidth(x, room.font)) + CRUMB_PAD;
    return fitCrumbs(
      { folder: t(folder), dirs: all.map(t), file: t(name) + FILE_CHROME - CRUMB_PAD, fileChrome: FILE_CHROME, sep: SEP, ellipsis: t("…"), gap: GAP },
      room.width,
      textWidth("abcdefghijklmnopqrstuvwxyz", room.font) / 26,
    );
    // `all` is derived from `path`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, folder, path, name]);
  const Icon = fileIcon(name);
  // A crumb is a quiet link: no padding of its own, so its width is the text plus the CRUMB_PAD the fit model counts.
  const crumb = "h-6 px-1";
  const dirOf = (i: number) => all.slice(0, i + 1).join("/");
  const hidden = plan.hidden.map((i) => (i < 0 ? { label: folder, path: "" } : { label: all[i] ?? "", path: dirOf(i) }));
  return (
    <nav
      ref={nav}
      aria-label="File path"
      className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap"
      title={middleTruncate(`${folder}/${path}`, 96)}
    >
      {plan.folder && (
        <Button variant="link" tone="quiet" size="sm" className={crumb} title={`Reveal ${folder} in the tree`} onClick={() => code.revealDir(folder, "")}>
          {folder}
        </Button>
      )}
      {hidden.length > 0 && (
        <>
          {plan.folder && <Sep />}
          <HiddenCrumbs folder={folder} dirs={hidden} />
        </>
      )}
      {plan.dirs.map((i) => (
        <Fragment key={i}>
          <Sep />
          <Button
            variant="link"
            tone="quiet"
            size="sm"
            className={crumb}
            title={`Reveal ${folder}/${dirOf(i)} in the tree`}
            onClick={() => code.revealDir(folder, dirOf(i))}
          >
            {all[i]}
          </Button>
        </Fragment>
      ))}
      {(plan.folder || hidden.length > 0) && <Sep />}
      <span aria-current="page" className="flex h-6 min-w-0 items-center gap-2 px-1 text-sm text-fg" title={name}>
        <Glyph icon={Icon} size={14} className="shrink-0 text-fg-3" />
        <span className="min-w-0 overflow-hidden">{crumbName(name, plan)}</span>
      </span>
    </nav>
  );
}

/** The "…" crumb: a menu of the directories it stands for (each reveals itself in the tree). */
function HiddenCrumbs({ folder, dirs }: { folder: string; dirs: { label: string; path: string }[] }) {
  const code = useCode();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={button}
        variant="link"
        tone="quiet"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`${dirs.length} hidden ${dirs.length === 1 ? "folder" : "folders"}: ${dirs.map((d) => d.label).join("/")}`}
        title={dirs.map((d) => d.label).join("/")}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        className={cn("h-6 px-1", menu && "bg-active text-fg")}
      >
        …
      </Button>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Folders in the path"
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={dirs.map((d) => ({ id: d.path || "(root)", label: d.label, title: `${folder}/${d.path}`, run: () => code.revealDir(folder, d.path) }))}
          />
        )}
      </Presence>
    </>
  );
}

function Sep() {
  return <Glyph icon={ChevronRight} size={14} className="shrink-0 text-fg-3" />;
}

/** Preview | Source for Markdown (remembered per tab): two 24px segments, the current one filled. */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange(m: Mode): void }) {
  const item = (m: Mode, label: string) => (
    <Button variant="quiet" size="xs" pressed={mode === m} onClick={() => onChange(m)}>
      {label}
    </Button>
  );
  return (
    <div role="group" aria-label="Markdown view" className="flex shrink-0 items-center gap-0.5">
      {item("preview", "Preview")}
      {item("source", "Source")}
    </div>
  );
}

function MoreMenu({ tab, folder, path }: { tab: TabId; folder: string; path: string }) {
  const ws = useWorkspace();
  const code = useCode();
  const [, copy] = useCopy();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const absolute = code.folders.find((f) => f.label === folder)?.path;
  return (
    <>
      <IconButton
        ref={button}
        icon={Ellipsis}
        label="File actions"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className={cn(menu && "bg-active text-fg")}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
        }}
      />
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="File actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              {
                id: "path",
                label: "Copy path",
                ...(absolute ? { title: `${absolute}/${path}` } : {}),
                run: () => copy(absolute ? `${absolute.replace(/\/$/, "")}/${path}` : `${folder}/${path}`),
              },
              { id: "rel", label: "Copy relative path", title: `${folder}/${path}`, run: () => copy(`${folder}/${path}`) },
              { id: "reveal", label: "Reveal in tree", run: () => code.openFile(folder, path) },
              { id: "sep", separator: true },
              { id: "move", label: "Move to the other side", disabled: !ws.canMoveToOtherSide(tab), run: () => ws.moveToOtherSide(tab) },
            ]}
          />
        )}
      </Presence>
    </>
  );
}

function Message({ file, name, showLoading }: { file: OpenFile | undefined; name: string; showLoading: boolean }) {
  const code = useCode();
  if (showLoading || !file || file.status === "loading" || file.status === "ready") {
    // The editor's place holds grey lines from the first frame (decision 60); the words are for screen readers.
    if (!showLoading && file?.status === "ready") return null;
    return (
      <div className="relative h-full">
        <EditorSkeleton />
        <p role="status" className="sr-only">
          Opening {name}…
        </p>
      </div>
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
