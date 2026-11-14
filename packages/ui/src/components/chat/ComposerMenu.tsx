import type { Bridge, PluginAgent } from "@octo/agent-client";
import { AtSign, Image as ImageIcon, MessageSquare, Search, type LucideIcon } from "lucide-react";
import { GLYPH } from "../primitives/glyphs";
import { Glyph } from "../primitives/Glyph";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../../state/app";
import { useOptionalCode } from "../../state/code";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { PickerSection } from "../../lib/picker";
import { fileIcon } from "../primitives/fileIcons";
import { usePresence } from "../primitives/Presence";
import { PopupList, popupOptionId, POPUP_PANEL } from "../primitives/PopupList";
import { popupMove } from "../primitives/popupNav";
import { useLatest } from "../../lib/hooks";

/** What picking an entry does: text goes into the composer at the trigger (or the caret); `run` does something else. */
export type MenuPick = { insert: string } | { run(): void };

type Entry = { id: string; group: string; label: string; detail?: string; hint: string; icon: LucideIcon; match: string; pick: MenuPick };

const FILES_SHOWN = 6;
/** Above the composer box when typed; 4px above the "+" chip when opened by it (decision 56). */
const GAP = 6;
const CHIP_GAP = 4;

const plugins = new WeakMap<Bridge, Promise<PluginAgent[]>>();
function availableAgents(bridge: Bridge): Promise<PluginAgent[]> {
  let p = plugins.get(bridge);
  if (!p) {
    p = bridge.listPlugins().then(
      (list) => list.flatMap((pl) => pl.agents.filter((a) => a.available)),
      () => {
        plugins.delete(bridge);
        return [];
      },
    );
    plugins.set(bridge, p);
  }
  return p;
}

export type ComposerMenuHandle = { onKeyDown(e: KeyboardEvent): boolean };

/**
 * The composer's "+" menu: one searchable list above the composer (overlay, radius 10, 28px rows, 8
 * visible, the match highlighted, the selected row's hint on the right). Opened by the "+" button
 * (it then has its own search field) or by typing `/` or `@` at the start of a word (the composer's
 * text after the trigger is the query and focus stays in the composer: ↑/↓/Enter/Tab/Esc are forwarded).
 * Keys follow decision 95 (`popupNav`): both inputs are text fields, so plain Home / End move the caret and Ctrl+Home / End jump;
 * Tab accepts the active row only as the mention menu (a completion of what is typed); in the "+" menu Tab keeps focus in its
 * search field, the panel's only focusable element, and focus leaving the panel closes it. Resizing the window closes it, as
 * `Menu` and `Popover` do (B9).
 * Groups appear only with entries: Files (the same loader as Filter files), Agents (available plugin
 * ACP agents), Comments (pending), Project actions; Attach (image, mention a file) comes first.
 */
export const ComposerMenu = forwardRef<
  ComposerMenuHandle,
  {
    anchor: RefObject<HTMLElement | null>;
    /** The composer box: the menu is as wide as it (up to 480px); when it is the anchor too, the menu sits above it. */
    box: RefObject<HTMLElement | null>;
    /** Query typed in the composer after the trigger; null when opened by the button (own search field). */
    query: string | null;
    listId: string;
    onActive(id: string | null): void;
    pendingComments: number;
    onOpenComments(): void;
    /** "Image…": the host's file dialog or the platform's. */
    onPickImage(): void;
    onPick(pick: MenuPick): void;
    /** `escape`: Esc closed it (opened by the button, focus goes back to the button; after a pick or a click it goes to the text). */
    onClose(reason?: "escape"): void;
  }
>(function ComposerMenu(props, handle) {
  const { bridge } = useApp();
  const code = useOptionalCode();
  const ws = useOptionalWorkspace();
  const state = usePresence();
  const [ownQuery, setOwnQuery] = useState("");
  const query = (props.query ?? ownQuery).trim().toLowerCase();
  const [agents, setAgents] = useState<PluginAgent[]>([]);
  // The pick belongs to the query it was made under: typing starts again from the first row.
  const [pick, setPick] = useState<{ query: string; id: string | null }>({ query: "", id: null });
  const selected = pick.query === query ? pick.id : null;
  const setSelected = (id: string) => setPick({ query, id });
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const { onActive, onClose } = props;

  useEffect(() => {
    let alive = true;
    void availableAgents(bridge).then((a) => alive && setAgents(a));
    return () => {
      alive = false;
    };
  }, [bridge]);
  const indexFiles = code?.indexFiles;
  useEffect(() => indexFiles?.(), [indexFiles]);

  const entries = useMemo(() => {
    const out: Entry[] = [
      // C6: attaching comes first, in its own clearly named group; project actions are a separate group below.
      {
        id: "attach:image",
        group: "Attach",
        label: "Attach image…",
        hint: "Choose from disk",
        icon: ImageIcon,
        match: "attach image picture photo screenshot",
        pick: { run: props.onPickImage },
      },
      { id: "attach:file", group: "Attach", label: "Mention a file", hint: "Type @", icon: AtSign, match: "mention file path", pick: { insert: "@" } },
    ];
    const files = code?.loadedFiles ?? [];
    const hits = query ? files.filter((f) => `${f.folder}/${f.path}`.toLowerCase().includes(query)) : files;
    // Ranked: name matches before path matches, then shorter paths.
    const name = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    hits
      .slice()
      .sort((a, b) => Number(!name(a.path).includes(query)) - Number(!name(b.path).includes(query)) || a.path.length - b.path.length)
      .slice(0, FILES_SHOWN)
      .forEach((f) => {
        const path = `${f.folder}/${f.path}`;
        out.push({
          id: `file:${path}`,
          group: "Files",
          label: f.path.slice(f.path.lastIndexOf("/") + 1),
          detail: path,
          hint: "Insert path",
          icon: fileIcon(f.path),
          match: path,
          pick: { insert: `\`${path}\` ` },
        });
      });
    for (const a of agents) {
      const text = `Use the ${a.label} agent for this.`;
      out.push({
        id: `agent:${a.id}`,
        group: "Agents",
        label: a.label,
        detail: "ACP agent",
        hint: "Insert",
        icon: GLYPH.agent,
        match: a.label,
        pick: { insert: `${text} ` },
      });
    }
    if (props.pendingComments > 0) {
      const label = `Review ${props.pendingComments} pending ${props.pendingComments === 1 ? "comment" : "comments"}`;
      out.push({ id: "comments", group: "Comments", label, hint: "Open", icon: MessageSquare, match: label, pick: { run: props.onOpenComments } });
    }
    if (ws) {
      const actions: [string, string, LucideIcon, () => void][] = [
        ["settings", "Project settings", GLYPH.settings, ws.openSettings],
        ["agents", "Show agents", GLYPH.agents, () => ws.openTool("agents")],
        ["notes", "Show notes", GLYPH.notes, () => ws.openTool("notes")],
        ["files", "Show files", GLYPH.files, () => ws.openTool("files")],
        ["details", "Show project details", GLYPH.details, () => ws.openTool("details")],
      ];
      for (const [id, label, icon, run] of actions) out.push({ id: `action:${id}`, group: "Project", label, hint: "Run", icon, match: label, pick: { run } });
    }
    return query ? out.filter((e) => e.group === "Files" || e.match.toLowerCase().includes(query)) : out;
  }, [code?.loadedFiles, agents, props.pendingComments, props.onOpenComments, props.onPickImage, ws, query]);

  // Entries are keyed by id; the selection survives the list changing under it while its row is still there.
  const current = entries.find((e) => e.id === selected) ?? entries[0] ?? null;
  const currentId = current?.id ?? null;
  const optionId = (id: string) => popupOptionId(props.listId, id);
  useEffect(() => onActive(currentId === null ? null : optionId(currentId)));
  useEffect(() => () => onActive(null), [onActive]);

  // Above its anchor, on the anchor's left edge, as wide as the composer box (up to 480px) and never past the window. A window
  // resize closes it, as it closes `Menu` and `Popover` (B9): the anchor moves after the resize, so a measure on `resize` was stale.
  const close = useLatest(onClose);
  useLayoutEffect(() => {
    const r = props.anchor.current?.getBoundingClientRect();
    const b = props.box.current?.getBoundingClientRect();
    if (r && b) {
      const width = Math.min(b.width, 480, window.innerWidth - 16);
      const gap = props.anchor.current === props.box.current ? GAP : CHIP_GAP;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), bottom: window.innerHeight - r.top + gap, width });
    }
    const onResize = () => close.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [props.anchor, props.box, close]);

  // Opened by the button, the search field takes focus once the panel exists (it renders after `pos`).
  const placed = pos !== null;
  useEffect(() => {
    if (props.query === null && placed) search.current?.focus();
  }, [props.query, placed]);
  // Focus that leaves the "+" menu's search for anything but the menu or its button closes it (decision 95); a move to nothing
  // (the window lost focus) does not.
  const plus = props.query === null;
  useEffect(() => {
    const el = panel.current;
    if (!plus || !el) return;
    const left = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to instanceof Node && !el.contains(to) && !props.anchor.current?.contains(to)) onClose();
    };
    el.addEventListener("focusout", left);
    return () => el.removeEventListener("focusout", left);
  }, [plus, placed, onClose, props.anchor]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !props.anchor.current?.contains(t) && !props.box.current?.contains(t)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose, props.anchor, props.box]);

  const choose = (e: Entry | undefined) => e && props.onPick(e.pick);

  const keys = (e: KeyboardEvent): boolean => {
    const to = popupMove(
      e,
      true,
      entries.map((x) => x.id),
      currentId,
    );
    if (to !== null) {
      setSelected(to);
      return true;
    }
    // In the "+" menu Tab moves focus, and the search field is the panel's only focusable element: it stays there.
    if (e.key === "Tab" && props.query === null) return true;
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (!current) return false;
      choose(current);
      return true;
    }
    if (e.key === "Escape") {
      onClose("escape");
      return true;
    }
    return false;
  };
  useImperativeHandle(handle, () => ({ onKeyDown: keys }));

  if (!pos) return null;
  const sections: PickerSection[] = [...new Set(entries.map((e) => e.group))].map((g) => ({
    title: g,
    rows: entries
      .filter((e) => e.group === g)
      .map((e) => {
        const Icon = e.icon;
        return {
          id: e.id,
          label: e.label,
          hint: e.hint,
          lead: <Glyph icon={Icon} size={14} />,
          run: () => choose(e),
          ...(e.detail ? { title: e.detail } : {}),
          ...(e.detail && e.group === "Files" ? { detail: e.detail.slice(0, e.detail.lastIndexOf("/")), pathDetail: true } : {}),
        };
      }),
  }));
  return createPortal(
    <div ref={panel} data-composer-menu data-state={state} style={{ left: pos.left, bottom: pos.bottom, width: pos.width }} className={POPUP_PANEL}>
      {props.query === null && (
        <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-3">
          <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
          <input
            ref={search}
            role="combobox"
            aria-expanded="true"
            aria-controls={props.listId}
            aria-activedescendant={currentId !== null ? optionId(currentId) : undefined}
            aria-label="Search files, agents and actions"
            placeholder="Search files, agents, actions"
            value={ownQuery}
            onChange={(e) => setOwnQuery(e.target.value)}
            onKeyDown={(e) => {
              if (keys(e)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
          />
        </div>
      )}
      <PopupList
        id={props.listId}
        label="Insert or run"
        sections={sections}
        activeId={currentId}
        onActive={setSelected}
        onChoose={(r) => r.run()}
        query={query}
        hintOnActive
        empty={code?.fileIndex.status === "loading" ? "Searching…" : "Nothing matches"}
      />
    </div>,
    document.body,
  );
});
