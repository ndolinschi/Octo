import type { Bridge, PluginAgent } from "@octo/agent-client";
import { MessageSquare, Search, type LucideIcon } from "lucide-react";
import { GLYPH } from "../primitives/glyphs";
import { Glyph } from "../primitives/Glyph";
import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useApp } from "../../state/app";
import { useOptionalCode } from "../../state/code";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Highlight } from "../files/FileTree";
import { fileIcon } from "../primitives/fileIcons";
import { usePresence } from "../primitives/Presence";

/** What picking an entry does: text goes into the composer at the trigger (or the caret); `run` does something else. */
export type MenuPick = { insert: string } | { run(): void };

type Entry = { id: string; group: string; label: string; detail?: string; hint: string; icon: LucideIcon; match: string; pick: MenuPick };

/** Rows shown at most (28px each); the list scrolls past that. */
const VISIBLE = 8;
const ROW = 28;
const FILES_SHOWN = 6;
const GAP = 6;

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
 * text after the trigger is the query and focus stays in the composer: ↑/↓/Enter/Esc are forwarded).
 * Groups appear only with entries: Files (the same loader as Filter files), Agents (available plugin
 * ACP agents), Comments (pending), Actions.
 */
export const ComposerMenu = forwardRef<
  ComposerMenuHandle,
  {
    anchor: RefObject<HTMLElement | null>;
    /** Query typed in the composer after the trigger; null when opened by the button (own search field). */
    query: string | null;
    listId: string;
    onActive(id: string | null): void;
    pendingComments: number;
    onOpenComments(): void;
    onPick(pick: MenuPick): void;
    onClose(): void;
  }
>(function ComposerMenu(props, handle) {
  const { bridge } = useApp();
  const code = useOptionalCode();
  const ws = useOptionalWorkspace();
  const state = usePresence();
  const [ownQuery, setOwnQuery] = useState("");
  const query = (props.query ?? ownQuery).trim().toLowerCase();
  const [agents, setAgents] = useState<PluginAgent[]>([]);
  const [selected, setSelected] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const baseId = useId();
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
    const out: Entry[] = [];
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
      for (const [id, label, icon, run] of actions) out.push({ id: `action:${id}`, group: "Actions", label, hint: "Run", icon, match: label, pick: { run } });
    }
    return query ? out.filter((e) => e.group === "Files" || e.match.toLowerCase().includes(query)) : out;
  }, [code?.loadedFiles, agents, props.pendingComments, props.onOpenComments, ws, query]);

  const current = entries.length ? Math.min(selected, entries.length - 1) : -1;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  useEffect(() => setSelected(0), [query]);
  useEffect(() => onActive(current >= 0 ? optionId(current) : null));
  useEffect(() => () => onActive(null), [onActive]);
  useEffect(() => {
    if (current >= 0) panel.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: "nearest" });
  });

  // Above the composer box, on its left edge and as wide (up to 480px).
  useLayoutEffect(() => {
    const place = () => {
      const r = props.anchor.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + GAP, width: Math.min(r.width, 480) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [props.anchor]);

  // Opened by the button, the search field takes focus once the panel exists (it renders after `pos`).
  const placed = pos !== null;
  useEffect(() => {
    if (props.query === null && placed) search.current?.focus();
  }, [props.query, placed]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !props.anchor.current?.contains(t)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose, props.anchor]);

  const choose = (e: Entry | undefined) => e && props.onPick(e.pick);

  const keys = (e: KeyboardEvent): boolean => {
    const n = entries.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return true;
      setSelected((current + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (!n) return false;
      choose(entries[current]);
      return true;
    }
    if (e.key === "Escape") {
      onClose();
      return true;
    }
    return false;
  };
  useImperativeHandle(handle, () => ({ onKeyDown: keys }));

  if (!pos) return null;
  let index = -1;
  const groups = [...new Set(entries.map((e) => e.group))];
  return createPortal(
    <div
      ref={panel}
      data-composer-menu
      data-state={state}
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
      className="octo-overlay fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-transparent bg-overlay text-sm shadow-pop [--octo-origin:0%_100%]"
    >
      {props.query === null && (
        <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-3">
          <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
          <input
            ref={search}
            role="combobox"
            aria-expanded="true"
            aria-controls={props.listId}
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
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
      <div
        id={props.listId}
        role="listbox"
        aria-label="Insert or run"
        className="overflow-y-auto overscroll-contain p-1"
        style={{ maxHeight: VISIBLE * ROW + 8 }}
      >
        {groups.map((g) => (
          <div key={g} role="group" aria-labelledby={`${baseId}-${g}`}>
            <div id={`${baseId}-${g}`} className="flex h-row items-center px-2 text-xs text-fg-3">
              {g}
            </div>
            {entries
              .filter((e) => e.group === g)
              .map((e) => {
                index += 1;
                const i = index;
                const Icon = e.icon;
                const isSelected = i === current;
                return (
                  <div
                    key={e.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isSelected}
                    title={e.detail}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onPointerMove={() => i !== current && setSelected(i)}
                    onClick={() => choose(e)}
                    className={cn("flex h-row items-center gap-2 rounded-sm px-2 press-row", isSelected ? "bg-active text-fg" : "text-fg")}
                  >
                    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg-3">
                      <Glyph icon={Icon} size={14} />
                    </span>
                    <span className="min-w-0 shrink-0 truncate">
                      <Highlight text={e.label} query={query} />
                    </span>
                    {e.detail && e.group === "Files" && (
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
                        {/* RTL truncation keeps the end of the path (nearest the file) visible. */}
                        <bdi>{e.detail.slice(0, e.detail.lastIndexOf("/"))}</bdi>
                      </span>
                    )}
                    {/* The hint slot is reserved on every row, so selecting one never shifts its folder column. */}
                    <span aria-hidden={!isSelected} className={cn("ml-auto shrink-0 pl-2 text-xs text-fg-3", !isSelected && "invisible")}>
                      {e.hint}
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
        {!entries.length && (
          <p className="flex h-row items-center px-2 text-xs text-fg-3">{code?.fileIndex.status === "loading" ? "Searching…" : "Nothing matches"}</p>
        )}
      </div>
    </div>,
    document.body,
  );
});
