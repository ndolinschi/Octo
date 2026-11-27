import { ArrowLeft, ArrowRight, ChevronRight, CodeXml, Ellipsis, Maximize2, Minimize2, PanelLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import {
  Fragment,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { fileKey as fileKeyOf, splitKey, type FileKey } from "../../lib/files";
import { middleTruncate } from "../../lib/format";
import { crumbFloor, crumbName, fitCrumbs } from "../../lib/crumbs";
import { useCopy, useDelayedLoading } from "../../lib/hooksMore";
import { usePhone } from "../../lib/phone";
import { useQuietOpen } from "../../lib/quietFocus";
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
import { EmptyState } from "../primitives/EmptyState";
import { IconButton } from "../primitives/IconButton";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { Segmented } from "../primitives/Segmented";
import { Spinner } from "../primitives/Status";
import { EditorSkeleton } from "./EditorSkeleton";
import { CodeEditor, warmMonacoNow, warmMonacoSoon, type CursorPos } from "./CodeEditor";
import { EditorStatus } from "./EditorStatus";
import { fileIcon, isMarkdown } from "../primitives/fileIcons";
import { fileSizeLabel, imageType, isSvg } from "../../lib/imagePreview";
import { TOOL_PURPOSE } from "../../lib/toolPurpose";
import { ImagePreview } from "./ImagePreview";
/** The Markdown preview loads with the first Markdown file (its own chunk). */
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })));
import { TreeColumn } from "./TreeColumn";
import { useTreeShell } from "./useTreeShell";
import { choiceCodec, PREFS, usePersistentState } from "../../lib/storage";
import { slot } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";

type CursorBus = {
  get(): CursorPos | null;
  set(pos: CursorPos | null): void;
  subscribe(listener: () => void): () => void;
};

function createCursorBus(): CursorBus {
  let current: CursorPos | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (pos) => {
      if (current?.line === pos?.line && current?.column === pos?.column) return;
      current = pos;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const CursorPosButton = memo(function CursorPosButton({ bus, onGoToLine }: { bus: CursorBus; onGoToLine(): void }) {
  const cursor = useSyncExternalStore(bus.subscribe, bus.get, bus.get);
  if (!cursor) return null;
  return (
    <Button
      variant="quiet"
      size="xs"
      data-cursor-pos
      title="Go to line"
      onClick={onGoToLine}
      className="shrink-0 font-mono text-xs text-fg-3 tabular-nums hover:text-fg"
    >
      Ln {cursor.line}, Col {cursor.column}
    </Button>
  );
});

const autoSaveCodec = choiceCodec(["on", "off"] as const, "off");
const AUTO_SAVE_DELAY_MS = 800;

/** Renders the floating composer over the editor area; `onHeight` reports the room it takes. Supplied by the dock. */
export type FloatingSlot = (onHeight: (px: number) => void, rest: boolean) => ReactNode;

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
  const ws = useWorkspace();
  const group = useGroup();
  const { project } = useProject();
  const { theme } = useApp();
  const file = fileKey ? code.file(fileKey) : undefined;
  const { folder, path } = fileKey ? splitKey(fileKey) : { folder: "", path: "" };
  const markdown = fileKey !== null && isMarkdown(path);
  // SVG is text that is also a picture: Preview | Source like Markdown, the same remembered choice (walk B15).
  const svg = fileKey !== null && isSvg(path);
  const [mode, setMode] = useTabMemory(tab, MD_MODE, "preview");
  const [autoSave, setAutoSave] = usePersistentState(PREFS.editorAutoSave, autoSaveCodec);
  const floating = useFloatingHere(tab);
  const [floatHeight, setFloatHeight] = useState(0);
  const bottomRoom = floating && floatHeight > 0 ? floatHeight + FLOAT_ROOM : 0;
  const opening = useDelayedLoading(fileKey !== null && (!file || file.status === "loading"));
  // A5 (polish pass F3): on a phone a file opens to read — a tap selects and scrolls, it does not raise the keyboard and type
  // into the file. "Edit" in the bar turns typing on for this file, "Done" off again.
  const phone = usePhone();
  const [editingKey, setEditingKey] = useState<FileKey | null>(null);
  const editing = editingKey !== null && editingKey === fileKey;
  const readFirst = phone && !editing;
  const saving = useDelayedLoading(Boolean(file?.saving));

  const groupId = group?.groupId ?? "";
  const root = useRef<HTMLDivElement>(null);
  // B4.3: the filter or editor the dock focuses on opening draws no ring until the first key or press.
  useQuietOpen(root);
  const shell = useTreeShell(root, tab, fileKey, groupId);
  const { width, page, showEditor } = shell;
  const treeId = `${domId(tab)}-tree`;
  // A narrow bar: the completion model folds to its glyph (B21: never the file name first) and a ready server shows nothing
  // (its lone dot beside "Unsaved" read as a second unsaved mark; work-surface polish item 11).
  const compact = width > 0 && width < 640;
  // A very narrow bar (a phone): the page switch is its glyph, "Unsaved" only for screen readers (the tab's dot says it).
  const narrow = width > 0 && width < 440;
  // Page mode (E7): the page that shows takes focus — the selected row (else the filter) for the tree, the editor for a file.
  const showTreePage = () => {
    shell.showTree();
    focusSoon(() => {
      const t = document.getElementById(treeId);
      return t?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ?? t?.querySelector<HTMLElement>("input");
    });
  };
  const showEditorPage = () => {
    shell.showEditor();
    focusSoon(() => {
      const area = root.current?.querySelector("[data-editor-area]");
      return area?.querySelector<HTMLElement>(".monaco-editor textarea") ?? area?.querySelector<HTMLElement>("[data-file-focus]");
    });
  };
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

  // Item 3 (polish pass F3): Esc with nothing selected and no editor widget open leaves the editor for the file's tab (the
  // tab strip; a phone has none, so the bar's first control).
  const leaveEditor = useCallback(() => {
    const t = document.getElementById(`${domId(tab)}-tab`);
    const target = t && t.offsetParent !== null ? t : root.current?.querySelector<HTMLElement>("[data-file-bar] button:not([disabled])");
    target?.focus();
  }, [tab]);

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
  const [lastShown, setLastShown] = useState<OpenFile | null>(null);
  // The first file opens like the second: Monaco is warmed once the view has been on screen a second, or at once on intent.
  useEffect(() => warmMonacoSoon(), []);
  useEffect(() => {
    if (file?.status === "ready") setLastShown(file);
  }, [file]);
  const shown = file?.status === "ready" ? file : lastShown;
  const shownKey = shown?.key ?? null;
  const saveFile = code.save;
  const startIntelFn = code.startIntel;
  const onSaveEditor = useCallback(() => {
    if (shownKey) void saveFile(shownKey);
  }, [saveFile, shownKey]);

  // Claude Code Desktop parity: when Auto save is enabled, persist dirty edits after a short quiet window unless a conflict/error notice is showing.
  useEffect(() => {
    if (autoSave !== "on" || !file || file.status !== "ready" || !file.modified || file.saving || file.notice) return;
    const id = window.setTimeout(() => void saveFile(file.key), AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [autoSave, file, saveFile]);
  const onMonacoEditor = useCallback(
    (mod: Parameters<Parameters<typeof CodeEditor>[0]["onMonaco"]>[0]) => startIntelFn((o) => new mod.LspManager({ ...o, monaco: mod.monaco })),
    [startIntelFn],
  );
  const ready = file?.status === "ready" && !opening;
  let cover: ReactNode = null;
  if (!fileKey) {
    cover = code.folders.length ? <Cover title="No file open">{TOOL_PURPOSE.files} Filter the tree by name to find one.</Cover> : <NoFolders />;
  } else if (!ready) {
    cover = <Message file={file} folder={folder} path={path} showLoading={opening} bottomRoom={bottomRoom} />;
  } else if (markdown && mode === "preview") {
    cover = (
      <Suspense
        fallback={
          <div className="relative h-full">
            <EditorSkeleton />
            <p role="status" className="sr-only">
              Opening {file.name}…
            </p>
          </div>
        }
      >
        <MarkdownPreview file={file} bottomRoom={bottomRoom} onOpen={openHere} />
      </Suspense>
    );
  } else if (svg && mode === "preview" && project) {
    cover = (
      <ImagePreview
        key={file.key}
        projectId={project.id}
        folder={folder}
        path={path}
        sizeHint={undefined}
        svgText={code.buffers.value(file.key) ?? file.content}
        bottomRoom={bottomRoom}
        fallback={null}
        actions={null}
      />
    );
  }
  const [cursorBus] = useState(createCursorBus);
  const goToLineRef = useRef<(() => void) | null>(null);
  const onCursor = useCallback((pos: CursorPos | null) => cursorBus.set(pos), [cursorBus]);
  const onGoToLine = useCallback(() => goToLineRef.current?.(), []);
  const body = (
    <div className="relative h-full min-h-0">
      {fileKey !== null && (
        // `isolate`: Monaco's own layers (its scrollbars are z 11) stay inside this box, under the cover (finding B20).
        // Hide while covered so Monaco's GPU layers do not composite behind MarkdownPreview while scrolling.
        <div className={cn("absolute inset-0 isolate", cover !== null && "invisible [&_.scrollbar]:invisible!")} inert={cover !== null}>
          <CodeEditor
            file={shown}
            buffers={code.buffers}
            theme={theme}
            bottomPadding={Math.max(8, bottomRoom)}
            onSave={onSaveEditor}
            onMonaco={onMonacoEditor}
            onEscape={leaveEditor}
            onCursor={onCursor}
            goToLineRef={goToLineRef}
            readOnly={readFirst}
            wrap={phone && svg}
          />
        </div>
      )}
      {cover && <div className="absolute inset-0 z-10 bg-panel">{cover}</div>}
    </div>
  );

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} onPointerOver={warmMonacoNow} onPointerDown={warmMonacoNow}>
      {/* The hairline is an inset shadow, so the 40px row keeps a 40px content box (no half-pixel centring). Polish step 4, E1:
          navigation · crumbs · one status slot (meta words: saving, unsaved, the language server when it is not ready) · one
          right-hand group of 28px controls with 16px glyphs, 4 apart. In page mode the Files / Editor switch is the first item. */}
      <div
        data-file-bar={fileKey ? "file" : "tree"}
        className="flex h-ctl-lg shrink-0 items-center gap-1 px-pane text-xs text-fg-3 shadow-[inset_0_-1px_0_var(--octo-line)]"
      >
        {page &&
          fileKey &&
          (narrow ? (
            <IconButton
              icon={shell.treePage ? CodeXml : PanelLeft}
              label={shell.treePage ? "Editor" : "Files"}
              title={shell.treePage ? "Show the editor" : "Show the file tree"}
              onClick={shell.treePage ? showEditorPage : showTreePage}
            />
          ) : (
            <Button
              variant="quiet"
              size="sm"
              icon={shell.treePage ? CodeXml : PanelLeft}
              title={shell.treePage ? "Show the editor" : "Show the file tree"}
              onClick={shell.treePage ? showEditorPage : showTreePage}
            >
              {shell.treePage ? "Editor" : "Files"}
            </Button>
          ))}
        <IconButton icon={ArrowLeft} label="Back" title="Back (previous file in this group)" disabled={!group?.canBack} onClick={group?.back} />
        <IconButton icon={ArrowRight} label="Forward" title="Forward (next file in this group)" disabled={!group?.canForward} onClick={group?.forward} />
        {/* A phone's header already names the file (A5): no crumbs, the bar keeps its controls. */}
        {fileKey ? (
          phone ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <Crumbs folder={folder} path={path} />
          )
        ) : (
          <p className="ml-1 min-w-0 flex-1 truncate px-1 text-sm text-fg-2">{project?.name}</p>
        )}
        <span data-file-status className="flex min-w-0 shrink items-center gap-2 pl-1 empty:hidden" role="status">
          {saving && (
            <>
              <Spinner size="xs" /> Saving…
            </>
          )}
          {file?.modified && !saving && <span className={narrow ? "sr-only" : "shrink-0"}>Unsaved</span>}
        </span>
        {fileKey && !narrow && cover === null && <CursorPosButton bus={cursorBus} onGoToLine={onGoToLine} />}
        {fileKey && (
          <EditorStatus
            compact={compact}
            hideReady={compact}
            intel={code.intel}
            fileKey={fileKey}
            onJump={(p) => code.openFile(folder, path, { line: p.line, column: p.column })}
          />
        )}
        <span data-file-actions className="flex shrink-0 items-center gap-1 empty:hidden">
          {(markdown || svg) && file?.status === "ready" && <ModeToggle label={svg ? "Image view" : "Markdown view"} mode={mode} onChange={setMode} />}
          {phone && fileKey && ready && cover === null && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                if (!editing) return setEditingKey(fileKey);
                setEditingKey(null);
                // Done: the on-screen keyboard goes with the caret (focus left in the editor; the button keeps its own).
                const a = document.activeElement;
                if (a instanceof HTMLElement && a.closest("[data-editor-area]")) a.blur();
              }}
            >
              {editing ? "Done" : "Edit"}
            </Button>
          )}
          {fileKey && (
            <MoreMenu
              tab={tab}
              folder={folder}
              path={path}
              autoSave={autoSave === "on"}
              onToggleAutoSave={() => setAutoSave((cur) => (cur === "on" ? "off" : "on"))}
            />
          )}
          {!ws.narrow && fileKey && (
            <IconButton
              icon={ws.maximised === groupId ? Minimize2 : Maximize2}
              label={ws.maximised === groupId ? "Restore editor size" : "Full screen editor"}
              title={ws.maximised === groupId ? "Restore editor size" : "Full screen editor"}
              aria-pressed={ws.maximised === groupId}
              onClick={() => ws.toggleMaximise(tab)}
            />
          )}
          {!page && (
            <IconButton
              icon={shell.open ? PanelLeftClose : PanelLeftOpen}
              label={shell.open ? "Hide file tree" : "Show file tree"}
              aria-expanded={shell.open}
              aria-controls={shell.open ? treeId : undefined}
              onClick={shell.toggleColumn}
            />
          )}
        </span>
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
            // Monaco's scrollbars set their own `visibility: visible`: hidden with the page (finding B20, page mode).
            page && shell.treePage && "invisible [&_.scrollbar]:invisible!",
          )}
        >
          {file && <Notice file={file} />}
          <div className="min-h-0 flex-1">{body}</div>
          {floating && floatingComposer(setFloatHeight, narrow)}
        </div>
      </div>
    </div>
  );
}

function NoFolders() {
  const ws = useWorkspace();
  return (
    <Cover
      title="No folders attached"
      actions={
        <Button size="sm" onClick={ws.openSettings}>
          Project settings
        </Button>
      }
    >
      Add one in project settings.
    </Cover>
  );
}

/** A cover over the editor's box (E5): the app's `EmptyState`, centred, on the panel. */
function Cover(props: { title: string; children?: ReactNode; actions?: ReactNode; tone?: "plain" | "err" }) {
  return (
    <div className="flex h-full flex-col">
      <EmptyState title={props.title} actions={props.actions} {...(props.tone ? { tone: props.tone } : {})}>
        {props.children}
      </EmptyState>
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
/** The floor never takes more than this (a very long name is shortened in the middle instead). */
const CRUMB_FLOOR_CAP = 120;
const GAP = 2;
const FILE_CHROME = CRUMB_PAD + 14 + 8;

/**
 * `folder › dir › file`: a folder or directory crumb reveals it in the tree; the file crumb carries its icon. The row
 * collapses by measured fit (`lib/crumbs.ts`): everything, then `folder › … › parent › file`, `… › parent › file`,
 * `… › file`; the "…" crumb is a menu of what it hides. The file name is shortened once (in the middle) only when it
 * alone does not fit. The crumbs take the room the status and the buttons leave; they never push into them.
 */
const Crumbs = memo(function Crumbs({ folder, path }: { folder: string; path: string }) {
  const code = useCode();
  const nav = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<{ width: number; font: string } | null>(null);
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const font = getComputedStyle(el).font || "13px sans-serif";
      setRoom((prev) => (prev && prev.width === width && prev.font === font ? prev : { width, font }));
    };
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
  // B21: the crumbs never get less room than `… › file`, so the status beside them folds before the name is cut.
  const floor = room
    ? Math.min(
        CRUMB_FLOOR_CAP,
        crumbFloor({
          folder: 0,
          dirs: [],
          file: Math.ceil(textWidth(name, room.font)) + FILE_CHROME,
          fileChrome: FILE_CHROME,
          sep: SEP,
          ellipsis: Math.ceil(textWidth("…", room.font)) + CRUMB_PAD,
          gap: GAP,
        }),
      )
    : 0;
  const Icon = fileIcon(name);
  // A crumb is a quiet link: no padding of its own, so its width is the text plus the CRUMB_PAD the fit model counts.
  const crumb = "h-ctl-xs px-1 text-fg-3 hover:text-fg";
  const dirOf = (i: number) => all.slice(0, i + 1).join("/");
  const hidden = plan.hidden.map((i) => (i < 0 ? { label: folder, path: "" } : { label: all[i] ?? "", path: dirOf(i) }));
  return (
    <nav
      ref={nav}
      aria-label="File path"
      className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap"
      style={floor ? { minWidth: floor } : undefined}
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
      <span aria-current="page" className="flex h-ctl-xs min-w-0 items-center gap-2 px-1 text-sm font-medium text-fg" title={name}>
        <Glyph icon={Icon} size={14} className="shrink-0 text-fg-3" />
        <span className="min-w-0 overflow-hidden">{crumbName(name, plan)}</span>
      </span>
    </nav>
  );
});

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
        className={cn("h-ctl-xs px-1 text-fg-3 hover:text-fg", menu && "bg-active text-fg")}
      >
        …
      </Button>
      <Presence show={menu !== null}>
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

/** The separator: quieter than the crumbs it separates. */
function Sep() {
  return <Glyph icon={ChevronRight} size={14} className="shrink-0 text-fg-3" />;
}

/** Preview | Source for Markdown (remembered per tab): the app's `Segmented` (a track, the chosen one raised). */
function ModeToggle({ label, mode, onChange }: { label: string; mode: Mode; onChange(m: Mode): void }) {
  return (
    <Segmented
      label={label}
      options={[
        { id: "preview", label: "Preview" },
        { id: "source", label: "Source" },
      ]}
      value={mode}
      onChange={onChange}
      className="mx-1"
    />
  );
}

function MoreMenu({
  tab,
  folder,
  path,
  autoSave,
  onToggleAutoSave,
}: {
  tab: TabId;
  folder: string;
  path: string;
  autoSave: boolean;
  onToggleAutoSave(): void;
}) {
  const ws = useWorkspace();
  const code = useCode();
  const [, copy] = useCopy();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const absolute = code.folders.find((f) => f.label === folder)?.path;
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const phone = usePhone();
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
  };
  return (
    <>
      {/* A5: a phone's header has its own "⋯" (the panels sheet) right above; the file's menu is a word there, so the two
          never read as one control twice. */}
      {phone ? (
        <Button
          ref={button}
          variant="quiet"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label="File actions"
          className={cn(menu && "bg-active text-fg")}
          onClick={toggle}
        >
          Actions
        </Button>
      ) : (
        <IconButton
          ref={button}
          icon={Ellipsis}
          label="File actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={cn(menu && "bg-active text-fg")}
          onClick={toggle}
        />
      )}
      <Presence show={menu !== null}>
        {menu && (
          <Menu
            label="File actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              {
                id: "auto-save",
                label: "Auto save",
                checked: autoSave,
                run: onToggleAutoSave,
              },
              {
                id: "lsp",
                label: code.intel.get(fileKeyOf(folder, path)).status?.state === "ready" ? "Restart language server (LSP)" : "Run language server (LSP)",
                run: () => code.intel.restart(fileKeyOf(folder, path)),
              },
              { id: "sep-save", separator: true },
              {
                id: "path",
                label: "Copy path",
                ...(absolute ? { title: `${absolute}/${path}` } : {}),
                run: () => copy(absolute ? `${absolute.replace(/\/$/, "")}/${path}` : `${folder}/${path}`),
              },
              { id: "rel", label: "Copy relative path", title: `${folder}/${path}`, run: () => copy(`${folder}/${path}`) },
              { id: "filename", label: "Copy filename", title: filename, run: () => copy(filename) },
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

function Message({
  file,
  folder,
  path,
  showLoading,
  bottomRoom,
}: {
  file: OpenFile | undefined;
  folder: string;
  path: string;
  showLoading: boolean;
  bottomRoom: number;
}) {
  const code = useCode();
  const projectId = useProject().project?.id;
  const [, copy] = useCopy();
  const name = path.slice(path.lastIndexOf("/") + 1);
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
  const absolute = code.folders.find((f) => f.label === folder)?.path;
  const fullPath = absolute ? `${absolute.replace(/\/$/, "")}/${path}` : `${folder}/${path}`;
  const actions = (
    <span className="flex flex-wrap items-center justify-center gap-1.5">
      {file.status === "error" && (
        <Button size="sm" variant="secondary" onClick={() => code.retryOpen(file.key)}>
          Retry
        </Button>
      )}
      <Button size="sm" variant="quiet" onClick={() => copy(fullPath)}>
        Copy path
      </Button>
      <Button size="sm" variant="quiet" onClick={() => code.openFile(folder, path)}>
        Reveal in tree
      </Button>
    </span>
  );
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const listedSize = code.dirs[fileKeyOf(folder, parent)]?.entries.find((e) => e.path === path)?.size;
  if (file.status === "too_large") {
    const image = imageType(path) !== null;
    return (
      <Cover title={image ? "Too large to preview" : "Too large to open here"} actions={actions}>
        {name} is {listedSize !== undefined ? `${fileSizeLabel(listedSize)}; the limit is 2 MB` : "larger than 2 MB"}.
      </Cover>
    );
  }
  if (file.status === "binary") {
    const notice = (
      <Cover title="Binary file" actions={actions}>
        {name} can't be shown as text.
      </Cover>
    );
    if (imageType(path) === null || !projectId) return notice;
    return (
      <ImagePreview
        key={file.key}
        projectId={projectId}
        folder={folder}
        path={path}
        sizeHint={listedSize}
        bottomRoom={bottomRoom}
        fallback={notice}
        actions={actions}
      />
    );
  }
  return (
    <Cover title={`Couldn't open ${name}`} tone="err" actions={actions}>
      {(file.error ?? "Unknown error").replace(/\.$/, "")}.
    </Cover>
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
        <Button size="sm" variant="quiet" onClick={() => void code.save(file.key, { overwrite: true })}>
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
        <Button size="sm" variant="quiet" onClick={() => code.dismissNotice(file.key)}>
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
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-1.5 text-sm text-fg-2"
    >
      <span className="min-w-0 flex-1 basis-48">{text}</span>
      <span className="flex shrink-0 items-center gap-1.5">{actions}</span>
    </div>
  );
}
