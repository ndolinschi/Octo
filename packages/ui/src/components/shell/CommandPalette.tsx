import type { Agent } from "@octo/agent-client";
import { Search } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { matchScore, rankGroups } from "../../lib/match";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { useRequests } from "../../state/requests";
import { usePresence } from "../primitives/Presence";
import { useModal } from "../primitives/useModal";

export type PaletteAction = { id: string; label: string; hint?: string; shortcut?: string; run(): void };

type Item = { id: string; label: string; detail?: string | undefined; shortcut?: string | undefined; run(): void };
type Group = { title: string; items: Item[] };

/** Rows per group with an empty query, and when filtering. */
const LIMIT = 6;

/**
 * Ctrl/Cmd+K: one input over projects, the open project's tabs, requests and agents, and actions
 * (app actions plus the workspace's tab actions).
 * The input keeps focus (combobox + listbox); arrows move the selection, Enter runs it.
 * Hovering highlights a row without moving the keyboard selection.
 */
export function CommandPalette(props: { openProjectId: string | null; actions: PaletteAction[]; onClose(): void }) {
  const { projects, bridge } = useApp();
  const nav = useNav();
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const baseId = useId();
  const openProject = projects?.find((p) => p.id === props.openProjectId);
  const { requests } = useRequests(openProject, true);
  const { onClose } = props;
  const state = usePresence();
  // The workspace's tabs and tab actions, as they are when the palette opens.
  const [workspace] = useState(() => {
    const api = nav.workspace();
    return api ? { api, tabs: api.tabs(), actions: api.actions() } : null;
  });

  useModal(panel, onClose);

  const openId = openProject?.id;
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    bridge.listAgents(openId).then(
      (a) => alive && setAgents(a),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, openId]);

  const groups = useMemo<Group[]>(() => {
    const now = Date.now();
    const go = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const rank = (items: Item[], text: (i: Item) => string): Item[] => {
      if (!query.trim()) return items.slice(0, LIMIT);
      return items
        .map((item, i) => ({ item, i, score: matchScore(query, text(item)) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, LIMIT)
        .map((x) => x.item);
    };
    const pid = openId;
    const all: Group[] = [
      {
        title: "Tabs",
        items: workspace
          ? rank(
              workspace.tabs.map((t) => ({ ...t, run: go(t.run) })),
              (i) => i.label,
            )
          : [],
      },
      {
        title: "Projects",
        items: rank(
          (projects ?? []).map((p) => ({
            id: `p:${p.id}`,
            label: p.name,
            detail: p.status === "running" ? "working" : formatRelative(p.updated_at, now),
            run: go(() => navigate(p.id)),
          })),
          (i) => i.label,
        ),
      },
      {
        title: "Requests",
        items: pid
          ? rank(
              (requests ?? []).map((r) => ({
                id: `r:${r.id}`,
                label: r.text.split("\n", 1)[0] ?? r.text,
                detail: formatRelative(r.created_at, now),
                run: go(() => {
                  nav.requestTurn({ projectId: pid, messageId: r.id });
                  navigate(pid);
                }),
              })),
              (i) => i.label,
            )
          : [],
      },
      {
        title: "Agents",
        items: pid
          ? rank(
              (agents ?? []).map((a) => {
                const root = a.parent_id === null;
                return {
                  id: `a:${a.id}`,
                  label: root ? "Orchestrator" : a.role,
                  detail: root ? undefined : a.title,
                  run: go(() => {
                    if (!workspace) return navigate(pid, root ? null : a.id);
                    if (root) workspace.api.focusChat();
                    else workspace.api.openAgent(a.id);
                  }),
                };
              }),
              (i) => `${i.label} ${i.detail ?? ""}`,
            )
          : [],
      },
      {
        title: "Actions",
        items: rank(
          [
            ...(workspace?.actions ?? []).map((a) => ({ ...a, id: `w:${a.id}`, run: go(a.run) })),
            ...props.actions.map((a) => ({ id: `x:${a.id}`, label: a.label, detail: a.hint, shortcut: a.shortcut, run: go(a.run) })),
          ],
          (i) => i.label,
        ),
      },
    ];
    // Groups follow the quality of their best match (lib/match.ts: word-start before mid-word before loose).
    return rankGroups(
      query,
      all.filter((g) => g.items.length),
      (g) => g.items.map((i) => i.label),
    );
  }, [query, projects, requests, agents, props.actions, openId, nav, onClose, workspace]);

  const flat = groups.flatMap((g) => g.items);
  const current = Math.min(selected, Math.max(0, flat.length - 1));
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: "nearest" });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!flat.length) return;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (current + 1) % flat.length,
      ArrowUp: () => (current - 1 + flat.length) % flat.length,
      PageDown: () => Math.min(flat.length - 1, current + 5),
      PageUp: () => Math.max(0, current - 5),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setSelected(move());
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      flat[current]?.run();
    }
  };

  let index = -1;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center p-3" inert={state === "closed"}>
      <div className="octo-scrim fixed inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div aria-hidden className="h-[10vh] shrink-0 sm:h-[14vh]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-state={state}
        className="octo-overlay relative flex max-h-[70vh] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-transparent bg-overlay shadow-pop"
      >
        <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-3">
          <Glyph icon={Search} size={16} className="shrink-0 text-fg-3" />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            aria-label="Search tabs, projects, requests, agents and actions"
            placeholder="Search tabs, projects, requests, agents, actions"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
          />
        </div>
        <div ref={list} id={`${baseId}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
          {groups.map((g) => (
            <div key={g.title} role="group" aria-labelledby={`${baseId}-${g.title}`} className="pb-1">
              <div id={`${baseId}-${g.title}`} className="flex h-row items-center px-2 text-xs text-fg-3">
                {g.title}
              </div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const isSelected = i === current;
                return (
                  <div
                    key={item.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={item.run}
                    className={cn(
                      // Radius 6 = palette radius (10) − list padding (4).
                      "flex h-row-nav items-center gap-3 rounded-sm px-2 text-sm press-row",
                      isSelected ? "bg-active text-fg" : "text-fg hover:bg-hover",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.detail && <span className={cn("max-w-[45%] shrink-0 truncate text-xs", isSelected ? "text-fg-2" : "text-fg-3")}>{item.detail}</span>}
                    {item.shortcut && <kbd className="shrink-0 rounded-2xs bg-active px-1 font-sans text-xs text-fg-2">{item.shortcut}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length && <p className="px-2 py-6 text-center text-sm text-fg-3">No matches for “{query.trim()}”</p>}
        </div>
        <p role="status" className="sr-only">
          {flat.length === 0 ? "No results" : flat.length === 1 ? "1 result" : `${flat.length} results`}
        </p>
      </div>
    </div>,
    document.body,
  );
}
