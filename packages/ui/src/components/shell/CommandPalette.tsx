import type { Agent } from "@octo/agent-client";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatRelative } from "../../lib/format";
import { matchScore } from "../../lib/match";
import { rankGroups } from "../../lib/matchMore";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { hitRow } from "../../lib/requestSearch";
import { useRequests } from "../../state/requests";
import { useRequestSearch } from "../../state/requestSearch";
import { ListRow } from "../primitives/ListRow";
import { usePresence } from "../primitives/Presence";
import { SearchField } from "../primitives/SearchField";
import { SectionHeader } from "../primitives/SectionHeader";
import { StateGlyph } from "../primitives/StateGlyph";
import { agentGlyph, orchestratorGlyph, type GlyphState } from "../../lib/stateGlyph";
import { projectRowLines } from "../../lib/orchestrator";
import { useOrchestrators } from "../../state/orchestrators";
import { useModal } from "../primitives/useModal";
import { popupListKey } from "../primitives/popupNav";

export type PaletteAction = { id: string; label: string; hint?: string; shortcut?: string; run(): void };

type Item = { id: string; label: string; detail?: string | undefined; shortcut?: string | undefined; glyph?: GlyphState; run(): void };
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
  const orchestrators = useOrchestrators(projects);
  const { requests } = useRequests(openProject, true);
  const past = useRequestSearch(query);
  const { onClose } = props;
  const state = usePresence();
  // The workspace's tabs and tab actions, as they are when the palette opens.
  const [workspace] = useState(() => {
    const api = nav.workspace();
    return api ? { api, tabs: api.tabs(), actions: api.actions() } : null;
  });

  useModal(panel, onClose);

  // The chosen command runs once the palette has started closing and focus is back on its opener (useModal's restore runs
  // first: its effect is declared above). A command that moves focus itself (a tool tab, a file, a dialog, the Files tree's
  // filter) keeps it; one that moves nothing leaves focus on the opener (decision 95b).
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (state !== "closed") return;
    const run = pending.current;
    pending.current = null;
    run?.();
  }, [state]);
  const runAfterClose = useCallback(
    (fn: () => void) => () => {
      pending.current = fn;
      onClose();
    },
    [onClose],
  );

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
    const go = runAfterClose;
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
            // Finding C / polish step 2 (F6): the project's real state (a failed one shows its glyph, not idle) and the sidebar's meta.
            detail: projectRowLines(orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }, now, p.updated_at).meta ?? undefined,
            glyph: orchestratorGlyph((orchestrators.get(p.id) ?? { kind: "idle" as const }).kind),
            run: go(() => navigate(p.id)),
          })),
          (i) => i.label,
        ),
      },
      {
        // Decision 94d: ONE "Requests" group: this project's first (its loaded requests, then older hits of the harness's search),
        // then other projects' hits with the project dim on the right.
        title: "Requests",
        items: [
          ...(pid
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
            : []),
          ...past
            .filter((h) => !(h.project_id === pid && (requests ?? []).some((r) => r.id === h.message_id)))
            .sort((x, y) => Number(y.project_id === pid) - Number(x.project_id === pid))
            .map((h) => ({
              ...hitRow(h),
              run: go(() => {
                nav.requestTurn({ projectId: h.project_id, messageId: h.message_id });
                navigate(h.project_id);
              }),
            })),
        ],
      },
      {
        title: "Agents",
        items: pid
          ? rank(
              (agents ?? []).map((a) => {
                const root = a.parent_id === null;
                return {
                  id: `a:${a.id}`,
                  label: root ? "Conversation" : a.role,
                  detail: root ? undefined : a.title,
                  glyph: agentGlyph(a.status),
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
  }, [query, projects, orchestrators, requests, agents, props.actions, openId, nav, runAfterClose, workspace, past]);

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
    // Decision 95 (`popupNav`): the search is a text field, so plain Home / End move its caret and Ctrl+Home / End jump.
    const jump = popupListKey(e, true);
    const move = jump === "Home" ? () => 0 : jump === "End" ? () => flat.length - 1 : moves[e.key];
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
        <SearchField
          variant="header"
          label="Search tabs, projects, requests, agents and actions"
          placeholder="Search tabs, projects, requests, agents, actions"
          value={query}
          clearOnEscape={false}
          onChange={(v) => {
            setQuery(v);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          inputProps={{
            role: "combobox",
            "aria-expanded": true,
            "aria-controls": `${baseId}-list`,
            "aria-autocomplete": "list",
            ...(flat.length ? { "aria-activedescendant": optionId(current) } : {}),
          }}
        />
        <div ref={list} id={`${baseId}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
          {groups.map((g) => (
            <div key={g.title} role="group" aria-labelledby={`${baseId}-${g.title}`} className="pb-1">
              {/* Polish step 2 (F6): the caption on the rows' text edge, as in the sidebar. */}
              <SectionHeader as="h3" id={`${baseId}-${g.title}`} className="pr-2 pl-8">
                {g.title}
              </SectionHeader>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                return (
                  <ListRow
                    key={item.id}
                    id={optionId(i)}
                    role="option"
                    size="md"
                    selected={i === current}
                    onClick={item.run}
                    leading={item.glyph ? <StateGlyph state={item.glyph} box={16} /> : <span />}
                    title={item.label}
                    meta={item.shortcut ?? item.detail}
                  />
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
