import { ArrowLeft, ArrowRight, ChevronRight, Ellipsis, PanelRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { fileKey as fileKeyOf, splitKey, type FileKey } from "../../lib/files";
import { middleTruncate } from "../../lib/format";
import { crumbName, fitCrumbs } from "../../lib/crumbs";
import { useCopy, useDelayedLoading } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useCode, type OpenFile } from "../../state/code";
import { TREE_MIN, useFileView } from "../../state/fileView";
import { useProject } from "../../state/project";
import { fileTab, type TabId } from "../../state/workspace/layout";
import { focusSoon } from "../../lib/focus";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatingComposer, useFloatingHere } from "../chat/FloatingComposer";
import { useGroup } from "../dock/group";
import { domId } from "../../state/workspace/ids";
import { Button, IconButton } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { CodeEditor } from "./CodeEditor";
import { EditorStatus } from "./EditorStatus";
import { fileIcon, isMarkdown } from "../primitives/fileIcons";
import { MarkdownPreview } from "./MarkdownPreview";
import { TreeColumn } from "./TreeColumn";
import { EDITOR_MIN_WIDTH, FILE_VIEW_OVERLAY_BELOW } from "../../lib/constants";
import { slot } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";

/** Gap between the floating composer and the last line it must not cover (contract v6 decision 8). */
const FLOAT_ROOM = 16;

type Mode = "preview" | "source";
const MD_MODE = slot("md", (v): v is Mode => v === "preview" || v === "source");

/**
 * A file view: every File tab, and the Files tab while no file is open. One 40px breadcrumb row
 * (back / forward, crumbs, then status, Preview|Source for Markdown, a `…` menu and the tree toggle),
 * the editor edge to edge below it, and the tree column on the right (hairline on its left edge;
 * width and open state shared by every file view of the project). When no Chat tab is visible, the
 * focused file view shows the floating composer over its editor area (never over the tree).
 */
export function FileView({ tab, fileKey }: { tab: TabId; fileKey: FileKey | null }) {
  const code = useCode();
  const ws = useWorkspace();
  const fv = useFileView();
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

  // The view's own width decides whether the tree gets a column or floats over the editor.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A column that would leave the editor under `EDITOR_MIN_WIDTH` (a narrow file group beside the orchestrator) floats
  // over it instead, closed by default.
  const column = Math.max(TREE_MIN, Math.min(fv.treeWidth, Math.round(width * 0.4)));
  const overlay = width > 0 && (width < FILE_VIEW_OVERLAY_BELOW || width - column < EDITOR_MIN_WIDTH);
  // A narrow view keeps the editor visible: there the tree floats over it, starts closed (open in the
  // empty Files view), and closes
  // once a file is picked (the shared column preference is left alone).
  // The empty Files view exists to pick a file: its tree starts open.
  const [overlayOpen, setOverlayOpen] = useState(fileKey === null);
  const treeShown = overlay ? overlayOpen : fv.treeOpen;
  const setTreeShown = (open: boolean) => (overlay ? setOverlayOpen(open) : fv.setTreeOpen(open));
  const focusTick = useRef(fv.focusTreeTick);
  useEffect(() => {
    if (focusTick.current === fv.focusTreeTick) return;
    focusTick.current = fv.focusTreeTick;
    if (overlay && ws.isVisible(tab)) setOverlayOpen(true);
  }, [fv.focusTreeTick, overlay, ws, tab]);

  const treeId = `${domId(tab)}-tree`;
  // Files picked in this view's tree open in this group; the empty view turns into the file in place.
  const groupId = group?.groupId;
  // Opening a file never leaves focus on nothing: when the picked row went away (the overlay closed, the
  // empty Files view turned into the file in place), the file's editor or preview takes it.
  const openHere = useCallback(
    (f: string, p: string) => {
      setOverlayOpen(false);
      code.openFile(f, p, undefined, groupId ? (fileKey ? { group: groupId } : { group: groupId, replace: tab }) : undefined);
      const panel = `${domId(fileTab(fileKeyOf(f, p)))}-panel`;
      focusSoon(
        () => {
          const el = document.getElementById(panel);
          return el?.querySelector<HTMLElement>(".monaco-editor textarea") ?? el?.querySelector<HTMLElement>("[data-file-focus]");
        },
        { onlyIfLost: true, timeout: 1500 },
      );
    },
    [code, groupId, fileKey, tab],
  );

  // The overlay tree (narrow views) closes on Esc and on a pointer down outside it; focus goes back to the toggle.
  const toggle = useRef<HTMLButtonElement>(null);
  const overlayShown = overlay && overlayOpen;
  useEffect(() => {
    if (!overlayShown) return;
    const tree = () => document.getElementById(treeId);
    const close = (refocus: boolean) => {
      setOverlayOpen(false);
      if (refocus) requestAnimationFrame(() => toggle.current?.focus());
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = tree();
      if (!el || !(el.contains(document.activeElement) || toggle.current === document.activeElement)) return;
      e.preventDefault();
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || tree()?.contains(t) || toggle.current?.contains(t)) return;
      close(tree()?.contains(document.activeElement) ?? false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [overlayShown, treeId]);

  // Ctrl/Cmd+S anywhere in the view (Monaco binds it too; saving is guarded against doubles).
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (file) void code.save(file.key);
    }
  };

  let body: ReactNode;
  if (!fileKey) {
    body = <div className="grid h-full place-items-center text-sm text-fg-3">{code.folders.length ? "Select a file" : <NoFolders />}</div>;
  } else if (file?.status === "ready" && !opening) {
    body =
      markdown && mode === "preview" ? (
        <MarkdownPreview file={file} bottomRoom={bottomRoom} onOpen={openHere} />
      ) : (
        <CodeEditor
          file={file}
          buffers={code.buffers}
          theme={theme}
          bottomPadding={Math.max(8, bottomRoom)}
          onSave={() => void code.save(file.key)}
          onMonaco={(mod) => code.startIntel((o) => new mod.LspManager({ ...o, monaco: mod.monaco }))}
        />
      );
  } else {
    body = <Message file={file} name={path.slice(path.lastIndexOf("/") + 1)} showLoading={opening} />;
  }

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {/* The hairline is an inset shadow, so the 40px row keeps a 40px content box (no half-pixel centring). */}
      <div data-file-bar className="flex h-bar shrink-0 items-center gap-1 px-2 text-xs text-fg-3 shadow-[inset_0_-1px_0_var(--octo-line)]">
        <IconButton icon={ArrowLeft} label="Back" title="Back (previous file in this group)" disabled={!group?.canBack} onClick={group?.back} />
        <IconButton icon={ArrowRight} label="Forward" title="Forward (next file in this group)" disabled={!group?.canForward} onClick={group?.forward} />
        {fileKey ? (
          <Crumbs key={`${folder}/${path}`} folder={folder} path={path} />
        ) : (
          <p className="ml-1 min-w-0 flex-1 truncate px-1 text-sm text-fg-2">{project?.name}</p>
        )}
        <span className="flex shrink-0 items-center gap-2 pl-2">
          <span className="flex shrink-0 items-center gap-2 empty:hidden" role="status">
            {saving && (
              <>
                <Spinner size={10} /> Saving…
              </>
            )}
            {file?.modified && !saving && <span>Unsaved</span>}
          </span>
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
        <IconButton
          ref={toggle}
          icon={PanelRight}
          label={treeShown ? "Hide file tree" : "Show file tree"}
          aria-expanded={treeShown}
          aria-controls={treeShown ? treeId : undefined}
          onClick={() => setTreeShown(!treeShown)}
          className={cn(treeShown && "text-fg-2")}
        />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div data-editor-area className="relative flex min-w-0 flex-1 flex-col">
          {file && <Notice file={file} />}
          <div className="min-h-0 flex-1">{body}</div>
          {floating && <FloatingComposer onHeight={setFloatHeight} />}
        </div>
        {treeShown && (
          <TreeColumn
            id={treeId}
            tab={tab}
            overlay={overlay}
            maxWidth={overlay ? width - 48 : Math.max(TREE_MIN, Math.min(width - 320, Math.round(width * 0.4)))}
            onOpenFile={openHere}
          />
        )}
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
  const crumb = "press h-6 shrink-0 rounded-sm px-1 text-sm text-fg-3 hover:bg-hover hover:text-fg";
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
        <button type="button" className={crumb} title={`Reveal ${folder} in the tree`} onClick={() => code.revealDir(folder, "")}>
          {folder}
        </button>
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
          <button type="button" className={crumb} title={`Reveal ${folder}/${dirOf(i)} in the tree`} onClick={() => code.revealDir(folder, dirOf(i))}>
            {all[i]}
          </button>
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
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`${dirs.length} hidden ${dirs.length === 1 ? "folder" : "folders"}: ${dirs.map((d) => d.label).join("/")}`}
        title={dirs.map((d) => d.label).join("/")}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        className={cn("h-6 shrink-0 press rounded-sm px-1 text-sm text-fg-3 hover:bg-hover hover:text-fg", menu && "bg-active text-fg")}
      >
        …
      </button>
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
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      className={cn("h-6 press rounded-sm px-2 text-xs", mode === m ? "bg-active text-fg" : "text-fg-3 hover:bg-hover hover:text-fg")}
    >
      {label}
    </button>
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
