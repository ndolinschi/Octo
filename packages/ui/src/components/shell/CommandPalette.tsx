import type { Agent, FileSearchMatch } from "@octo/agent-client";
import { CornerDownLeft, FolderGit2, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { formatRelative } from "../../lib/format";
import { fieldScore, rankMatches } from "../../lib/match";
import { openShortcuts } from "../../lib/openShortcuts";
import { rankGroups } from "../../lib/matchMore";
import { navigate, settingsHref } from "../../lib/route";
import { focusSoon } from "../../lib/focus";
import { cn } from "../../lib/cn";
import { useMediaQuery, useScrollFade } from "../../lib/hooks";
import { useHistoryLayer } from "../../lib/historyLayer";
import { usePhone } from "../../lib/phone";
import { palette as paletteGate } from "../../lib/typeahead";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { workspaceActions, workspaceTabs } from "../../state/workspace/paletteCommands";
import { sessionTab } from "../../state/workspace/layout";
import { hitRow } from "../../lib/requestSearch";
import { useRequests } from "../../state/requests";
import { useRequestSearch } from "../../state/requestSearch";
import { Button } from "../primitives/Button";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { Highlight } from "../primitives/Highlight";
import { IconButton } from "../primitives/IconButton";
import { KeyHint } from "../primitives/KeyHint";
import { ListRow } from "../primitives/ListRow";
import { usePresence } from "../primitives/Presence";
import { SearchField } from "../primitives/SearchField";
import { SectionHeader } from "../primitives/SectionHeader";
import { Skeleton } from "../primitives/Skeleton";
import { StateGlyph } from "../primitives/StateGlyph";
import { agentGlyph, orchestratorGlyph, type GlyphState } from "../../lib/stateGlyph";
import { projectRowLines } from "../../lib/orchestratorMore";
import { isPending, useOrchestrators } from "../../state/orchestrators";
import { useSessionIndex } from "../../state/sessionIndex";
import { mainSessions, sessionGlyph, sessionMeta, sessionsBesideTabs, sessionTitle } from "../../lib/sessions/tree";
import { useModal } from "../primitives/useModal";
import { createPointerGate, popupListKey } from "../primitives/popupNav";

/** The settings sections and rows the palette searches (`settings/settingsIndex`; the app passes its loader: a feature may not import another). */
export type SettingsIndex = {
  SECTIONS: readonly { id: string; label: string }[];
  SETTINGS_INDEX: readonly { section: string; id: string; title: string; description: string; keywords?: string | undefined }[];
  sectionLabel(id: string): string;
};

export type PaletteAction = { id: string; label: string; hint?: string; shortcut?: string; run(): void };

type SearchCategory = "all" | "sessions" | "projects" | "files" | "actions" | "settings";

const CATEGORIES: readonly { id: SearchCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sessions", label: "Sessions" },
  { id: "projects", label: "Projects" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
  { id: "settings", label: "Settings" },
];

/** `search` is text that is searched but not shown (descriptions, keywords); an item without it is searched by its detail. */
type Item = {
  id: string;
  label: string;
  detail?: string | undefined;
  search?: string | undefined;
  shortcut?: string | undefined;
  glyph?: GlyphState;
  filePath?: string;
  isProject?: true;
  pending?: true;
  run(): void;
};
type Group = { title: string; items: Item[] };

/** Rows per group with an empty query, and when filtering. */
const LIMIT = 8;
/** With an empty query: high-frequency actions. */
const SUGGESTED = ["x:new", "w:tool-files", "w:tool-review", "x:settings", "x:shortcuts"];
/** Not offered on the phone (no keyboard there): the shortcut list and its "Help" row. */
const KEYBOARD_ONLY = new Set(["x:shortcuts", "x:help"]);
const THEMES = [
  ["dark", "Dark"],
  ["cursor", "Cursor"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["light", "Light"],
  ["system", "System"],
] as const;

/** Rows of "Recent" with an empty query. */
const RECENT = 4;

/** The projects last worked in, newest first, without the one that is open. */
function recentProjects<P extends { id: string; updated_at: string }>(projects: readonly P[], openId: string | undefined): P[] {
  return projects
    .filter((p) => p.id !== openId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RECENT);
}

/** Opens a settings section and, for a row, scrolls to it and focuses its control once the page has it. */
function openSetting(section: string, row?: string) {
  window.location.hash = settingsHref(section);
  if (!row) return;
  focusSoon(
    () => {
      const el = document.getElementById(`row-${row}`);
      el?.scrollIntoView({ block: "center" });
      return el?.querySelector<HTMLElement>("button, input, a[href]");
    },
    { timeout: 2500 },
  );
}

/**
 * Ctrl/Cmd+K: one search modal over sessions, projects, files, tabs, requests, agents, settings, and actions,
 * with category filter tabs (←/→ or Tab), Needs attention + Recents empty-query sections, and keyboard hints footer.
 */
export function CommandPalette(props: {
  /** NEW-7: which open this palette is (`lib/typeahead`): it takes only the keys held for it. */
  paletteId: number;
  initialMode?: "all" | "files";
  openProjectId: string | null;
  actions: PaletteAction[];
  settingsIndex: () => Promise<SettingsIndex>;
  onClose(): void;
}) {
  const { projects, bridge, canChooseTheme, themePref, setThemePref } = useApp();
  const narrow = useMediaQuery("(max-width: 600px)");
  const phone = usePhone();
  const nav = useNav();
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useScrollFade(list, "y");
  const gate = useRef(createPointerGate());
  const fromPointer = useRef(false);
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState<SearchCategory>(props.initialMode === "files" ? "files" : "all");
  const [selected, setSelected] = useState(0);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [fileMatches, setFileMatches] = useState<FileSearchMatch[]>([]);
  const [contentMatches, setContentMatches] = useState<FileSearchMatch[]>([]);
  const baseId = useId();
  const filesOnly = props.initialMode === "files" && props.openProjectId !== null;
  const effectiveCategory: SearchCategory = filesOnly ? "files" : category;
  const openProject = projects?.find((p) => p.id === props.openProjectId);
  const orchestrators = useOrchestrators(filesOnly ? null : projects);
  const sessionIndex = useSessionIndex(filesOnly ? null : projects);
  const { requests } = useRequests(openProject, !filesOnly);
  const pastHits = useRequestSearch(filesOnly ? "" : deferredQuery);
  const { onClose } = props;
  const state = usePresence();
  // The workspace's tabs and tab actions, as they are when the palette opens.
  const [workspace] = useState(() => {
    const api = nav.workspace();
    return api ? { api, tabs: workspaceTabs(api.current()), actions: workspaceActions(api.current()) } : null;
  });

  useModal(panel, onClose);
  // Direction 7: on the phone the palette is a history entry (the system's Back closes it, not the app).
  useHistoryLayer(phone && state === "open", () => onClose());

  // The chosen command runs once the palette has started closing and focus is back on its opener (useModal's restore runs
  // first: its effect is declared above). A command that moves focus itself (a tool tab, a file, a dialog, the Files tree's
  // filter) keeps it; one that moves nothing leaves focus on the opener (decision 95b).
  const pending = useRef<(() => void) | null>(null);
  const flushPending = useCallback(() => {
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);
  useEffect(() => {
    if (state === "closed") flushPending();
  }, [state, flushPending]);
  useEffect(() => flushPending, [flushPending]);
  const runAfterClose = useCallback(
    (fn: () => void) => () => {
      pending.current = fn;
      onClose();
    },
    [onClose],
  );

  const [settings, setSettings] = useState<SettingsIndex | null>(null);
  const { settingsIndex } = props;
  useEffect(() => {
    if (filesOnly) return;
    let alive = true;
    settingsIndex().then(
      (i) => alive && setSettings(i),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [settingsIndex, filesOnly]);

  const openId = openProject?.id;
  useEffect(() => {
    if (!openId || filesOnly) return;
    let alive = true;
    bridge.listAgents(openId).then(
      (a) => alive && setAgents(a),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, openId, filesOnly]);

  const rawSearch = query.trim();
  const contentOnly = (filesOnly || effectiveCategory === "files") && rawSearch.startsWith(":");
  const searchNeedle = contentOnly ? rawSearch.slice(1).trim() : rawSearch;
  const fileSearchActive = Boolean(openId && bridge.searchProjectFiles && (effectiveCategory === "files" || searchNeedle.length >= 2));

  useEffect(() => {
    const search = bridge.searchProjectFiles;
    if (!openId || !search || !fileSearchActive) return;
    let alive = true;
    const filesMode = effectiveCategory === "files";
    const delay = filesMode && searchNeedle === "" ? 0 : 120;
    const timer = window.setTimeout(() => {
      if (!contentOnly) {
        void search(openId, { q: searchNeedle, mode: "name", limit: filesMode ? 24 : 8 }).then(
          (m) => alive && setFileMatches(m),
          () => alive && setFileMatches([]),
        );
      } else {
        setFileMatches([]);
      }
      if (searchNeedle.length >= 2) {
        void search(openId, { q: searchNeedle, mode: "content", limit: filesMode ? 24 : 8 }).then(
          (m) => alive && setContentMatches(m),
          () => alive && setContentMatches([]),
        );
      } else {
        setContentMatches([]);
      }
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [bridge, openId, effectiveCategory, contentOnly, searchNeedle, fileSearchActive]);

  const visibleCategories = useMemo(() => (openId ? CATEGORIES : CATEGORIES.filter((c) => c.id !== "files")), [openId]);

  const groups = useMemo<Group[]>(() => {
    const go = runAfterClose;
    const activeFileMatches = fileSearchActive && !contentOnly ? fileMatches : [];
    const activeContentMatches = fileSearchActive && searchNeedle.length >= 2 ? contentMatches : [];
    const fileRows: Item[] = activeFileMatches.map((m) => ({
      id: `f:${m.folder}:${m.path}`,
      label: m.path,
      detail: openProject && openProject.folder_count > 1 ? m.folder : undefined,
      filePath: m.path,
      run: go(() => workspace?.api.openFile?.(m.folder, m.path)),
    }));
    const contentRows: Item[] = activeContentMatches.map((m, idx) => ({
      id: `fc:${m.folder}:${m.path}:${m.line ?? 0}:${idx}`,
      label: `${m.path}${m.line ? `:${m.line}` : ""}`,
      detail: m.preview,
      filePath: m.path,
      run: go(() => workspace?.api.openFile?.(m.folder, m.path, m.line)),
    }));
    if (effectiveCategory === "files") {
      const only: Group[] = [
        { title: "Files", items: fileRows },
        { title: "Matches in files", items: contentRows },
      ];
      return only.filter((g) => g.items.length);
    }
    const q = deferredQuery.trim();
    const pid = openId;
    const seen = new Set<string>();
    // The same request text of the same project is listed once (a repeated prompt is six rows otherwise).
    const fresh = (project: string, text: string) => {
      const key = `${project}\n${text.trim().toLowerCase()}`;
      return !seen.has(key) && !!seen.add(key);
    };
    const own: Item[] = [
      ...(phone
        ? []
        : [
            { id: "x:shortcuts", label: "Keyboard shortcuts", detail: "?", run: go(openShortcuts) },
            { id: "x:help", label: "Help", detail: "Shortcuts and how things work.", run: go(openShortcuts) },
          ]),
      {
        id: "x:model",
        label: "Change model",
        detail: "Choose the model this project uses.",
        run: go(() => {
          const chip = [...document.querySelectorAll<HTMLElement>("[data-model-picker]")].find((el) => el.offsetParent !== null);
          if (chip) chip.click();
          else openSetting("models");
        }),
      },
      ...(canChooseTheme
        ? THEMES.map(([value, name]) => ({
            id: `x:theme-${value}`,
            label: `Change theme: ${name}`,
            detail: themePref === value ? "current" : undefined,
            search: "dark light system appearance colour color mode",
            run: go(() => setThemePref(value)),
          }))
        : []),
    ];
    const actions: Item[] = [
      ...(workspace?.actions ?? []).map((a) => ({ ...a, id: `w:${a.id}`, ...(phone ? { shortcut: undefined } : {}), run: go(a.run) })),
      ...props.actions
        .filter((a) => !(phone && KEYBOARD_ONLY.has(`x:${a.id}`)))
        .map((a) => ({ id: `x:${a.id}`, label: a.label, detail: a.hint, shortcut: phone ? undefined : a.shortcut, run: go(a.run) })),
      ...own,
    ];
    // Settings: each section, then the rows of the settings search (description and keywords are searched, not shown).
    const { SECTIONS, SETTINGS_INDEX, sectionLabel } = settings ?? { SECTIONS: [], SETTINGS_INDEX: [], sectionLabel: () => "" };
    const settingRows: Item[] = [
      // A section whose own row has its name ("Providers") is the row.
      ...SECTIONS.filter((s) => !SETTINGS_INDEX.some((r) => r.title === s.label)).map((s) => ({
        id: `s:${s.id}`,
        label: s.label,
        detail: "Settings",
        run: go(() => openSetting(s.id)),
      })),
      ...SETTINGS_INDEX.filter((r) => r.id !== "shortcuts").map((r) => ({
        id: `s:${r.section}:${r.id}`,
        label: r.title,
        detail: sectionLabel(r.section),
        search: `${r.description} ${r.keywords ?? ""} ${sectionLabel(r.section)}`,
        run: go(() => openSetting(r.section, r.id)),
      })),
    ];
    const loaded: Item[] = pid
      ? (requests ?? []).flatMap((r) => {
          const label = r.text.split("\n", 1)[0] ?? r.text;
          return !q || fresh(pid, label)
            ? [
                {
                  id: `r:${r.id}`,
                  label,
                  detail: formatRelative(r.created_at, now),
                  run: go(() => {
                    nav.requestTurn({ projectId: pid, messageId: r.id });
                    // Decision 96: the request opens in its own session's conversation.
                    navigate(pid, null, r.session_id ?? null);
                  }),
                },
              ]
            : [];
        })
      : [];
    const projectRows: Item[] = (projects ?? []).map((p) => ({
      id: `p:${p.id}`,
      label: p.name,
      isProject: true as const,
      detail: projectRowLines(orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }, now, p.updated_at).meta ?? undefined,
      ...(isPending(orchestrators.get(p.id) ?? { kind: "new" })
        ? { pending: true as const }
        : { glyph: orchestratorGlyph((orchestrators.get(p.id) ?? { kind: "idle" as const }).kind) }),
      run: go(() => navigate(p.id)),
    }));
    const agentRows: Item[] = pid
      ? (agents ?? []).map((a) => {
          const root = a.parent_id === null;
          return {
            id: `a:${a.id}`,
            label: root ? "Session" : a.role,
            detail: root ? undefined : a.title,
            glyph: agentGlyph(a.status),
            run: go(() => {
              if (!workspace) return navigate(pid, root ? null : a.id);
              if (root) workspace.api.focusChat();
              else workspace.api.openAgent(a.id);
            }),
          };
        })
      : [];
    const tabRows: Item[] = workspace ? workspace.tabs.map((t) => ({ ...t, run: go(t.run) })) : [];
    const allMains = mainSessions(sessionIndex.all);
    const sessionRows: Item[] = sessionsBesideTabs(allMains, tabRows, (id) => `tab:${sessionTab(id)}`).map((s) => ({
      id: `ses:${s.id}`,
      label: sessionTitle(s),
      detail: [s.project_name, sessionMeta(s, now)].filter(Boolean).join(" · "),
      search: s.project_name,
      glyph: sessionGlyph(s),
      run: go(() => navigate(s.project_id, null, s.id)),
    }));
    const needsAttentionRows: Item[] = allMains
      .filter((s) => s.state === "waiting" || s.state === "failed")
      .slice(0, 4)
      .map((s) => ({
        id: `attn:${s.id}`,
        label: sessionTitle(s),
        detail: s.project_name,
        glyph: sessionGlyph(s),
        run: go(() => navigate(s.project_id, null, s.id)),
      }));
    const recentSessionRows: Item[] = allMains
      .filter((s) => s.state !== "waiting" && s.state !== "failed")
      .slice(0, 4)
      .map((s) => ({
        id: `rec:${s.id}`,
        label: sessionTitle(s),
        detail: s.project_name,
        glyph: sessionGlyph(s),
        run: go(() => navigate(s.project_id, null, s.id)),
      }));
    // The open project's row comes first: "New session" must not start one in whichever project is listed first.
    const newSessions: Item[] = [...(projects ?? [])]
      .sort((a, b) => Number(b.id === pid) - Number(a.id === pid))
      .map((p) => ({
        id: `n:${p.id}`,
        label: `New session in ${p.name}`,
        search: `new session start conversation ${p.name}`,
        run: go(() => {
          void bridge.createSession(p.id, {}).then(
            ({ session }) => {
              if (p.id === pid && workspace) workspace.api.openSession(session.id);
              else navigate(p.id, null, session.id);
            },
            () => undefined,
          );
        }),
      }));
    const lq = q.toLowerCase();
    const names = (name: string) =>
      name.toLowerCase().startsWith(lq) ||
      name
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .some((w) => w.startsWith(lq));
    const named = q === "" ? [] : (projects ?? []).filter((p) => names(p.name)).map((p) => `n:${p.id}`);
    const newSessionRows = named.length > 0 ? newSessions.filter((i) => named.includes(i.id)) : newSessions.slice(0, 2);
    const strict = [tabRows, projectRows, sessionRows, loaded, agentRows, actions, newSessionRows, settingRows].some((l) =>
      l.some((i) => fieldScore(q, i.label, i.search ?? i.detail).sub),
    );
    const rank = (items: Item[], limit = LIMIT) => rankMatches(q, items, (i) => [i.label, i.search ?? i.detail], limit, strict);
    const past = pastHits
      .filter((h) => fresh(h.project_id, hitRow(h).label))
      .sort((x, y) => Number(y.project_id === pid) - Number(x.project_id === pid))
      .map((h) => ({
        ...hitRow(h),
        run: go(() => {
          nav.requestTurn({ projectId: h.project_id, messageId: h.message_id });
          navigate(h.project_id);
        }),
      }));

    // Category-filtered views
    if (effectiveCategory === "sessions") {
      const list = q ? rank(sessionRows, 20) : sessionRows.slice(0, 16);
      const out: Group[] = [
        ...(!q && needsAttentionRows.length > 0 ? [{ title: "Needs attention", items: needsAttentionRows }] : []),
        { title: "Sessions", items: list },
      ];
      return out.filter((g) => g.items.length);
    }
    if (effectiveCategory === "projects") {
      const list = q ? rank(projectRows, 20) : projectRows;
      return list.length ? [{ title: "Projects", items: list }] : [];
    }
    if (effectiveCategory === "actions") {
      const combined = [...actions, ...newSessionRows];
      const list = q ? rank(combined, 20) : combined.slice(0, 16);
      return list.length ? [{ title: "Actions", items: list }] : [];
    }
    if (effectiveCategory === "settings") {
      const list = q ? rank(settingRows, 20) : settingRows.slice(0, 20);
      return list.length ? [{ title: "Settings", items: list }] : [];
    }

    // "All" view
    const all: Group[] = q
      ? [
          { title: "Files", items: fileRows },
          { title: "Matches in files", items: contentRows },
          { title: "Sessions", items: rank(sessionRows) },
          { title: "Projects", items: rank(projectRows) },
          { title: "Tabs", items: rank(tabRows) },
          { title: "Actions", items: rank([...actions, ...newSessionRows]) },
          { title: "Settings", items: rank(settingRows) },
          { title: "Requests", items: [...rank(loaded), ...past] },
          { title: "Agents", items: rank(agentRows) },
        ]
      : [
          { title: "Needs attention", items: needsAttentionRows },
          {
            title: "Recents",
            items: [...recentSessionRows, ...recentProjects(projects ?? [], pid).flatMap((p) => projectRows.find((r) => r.id === `p:${p.id}`) ?? [])].slice(
              0,
              6,
            ),
          },
          { title: "Actions", items: [...newSessionRows.slice(0, 1), ...SUGGESTED.flatMap((id) => actions.find((a) => a.id === id) ?? [])].slice(0, 5) },
        ];
    return rankGroups(
      deferredQuery,
      all.filter((g) => g.items.length),
      (g) => g.items.map((i) => `${i.label} ${i.search ?? i.detail ?? ""}`),
    );
  }, [
    deferredQuery,
    effectiveCategory,
    projects,
    openProject,
    orchestrators,
    requests,
    agents,
    fileMatches,
    contentMatches,
    fileSearchActive,
    contentOnly,
    searchNeedle,
    props.actions,
    openId,
    nav,
    runAfterClose,
    workspace,
    pastHits,
    canChooseTheme,
    themePref,
    setThemePref,
    settings,
    bridge,
    sessionIndex.all,
    phone,
    now,
  ]);

  const { flat, groupOffsets } = useMemo(() => {
    const items: Item[] = [];
    const offsets: number[] = [];
    for (const g of groups) {
      offsets.push(items.length);
      for (const item of g.items) items.push(item);
    }
    return { flat: items, groupOffsets: offsets };
  }, [groups]);
  const current = Math.min(selected, Math.max(0, flat.length - 1));
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const stepCategory = (delta: -1 | 1) => {
    if (filesOnly) return;
    const idx = visibleCategories.findIndex((c) => c.id === category);
    const next = visibleCategories[(idx + delta + visibleCategories.length) % visibleCategories.length];
    if (next) {
      setCategory(next.id);
      setSelected(0);
    }
  };

  // P2-7: the keys typed since Ctrl/Cmd+K (held while this chunk loaded) go into the field when it takes focus; a held
  // Enter runs the first row once the rows for that text are in (the render after the query is set).
  const typedEnter = useRef<string | null>(null);
  const { paletteId } = props;
  useEffect(() => () => paletteGate.exited(paletteId), [paletteId]);
  const takeTyped = () => {
    const typed = paletteGate.ready(paletteId);
    if (typed.text) {
      if (typed.enter) typedEnter.current = typed.text;
      setQuery(typed.text);
    } else if (typed.enter) flat[current]?.run();
  };
  useEffect(() => {
    if (typedEnter.current === null || typedEnter.current !== deferredQuery) return;
    typedEnter.current = null;
    flat[current]?.run();
  }, [deferredQuery, flat, current]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    list.current?.querySelector(`#${CSS.escape(`${baseId}-opt-${current}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [current, baseId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!filesOnly) {
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        stepCategory(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && query === "" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        stepCategory(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
    }
    if (!flat.length) return;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (current + 1) % flat.length,
      ArrowUp: () => (current - 1 + flat.length) % flat.length,
      PageDown: () => Math.min(flat.length - 1, current + 5),
      PageUp: () => Math.max(0, current - 5),
    };
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

  const highlightQuery = (filesOnly || effectiveCategory === "files") && query.trim().startsWith(":") ? query.trim().slice(1).trim() : query;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center p-3" inert={state === "closed"}>
      <div className="octo-scrim fixed inset-0 bg-scrim" data-state={state} onMouseDown={onClose} aria-hidden />
      <div aria-hidden className="h-[8vh] shrink-0 sm:h-[12vh]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={filesOnly ? "Quick open file" : "Search"}
        data-state={state}
        className="octo-overlay relative flex max-h-[72vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-panel-edge bg-overlay shadow-pop forced-colors:border forced-colors:border-[CanvasText]"
      >
        <div className="flex shrink-0 items-center pr-2">
          <SearchField
            variant="header"
            className="min-w-0 flex-1 border-b-0!"
            label={filesOnly ? "Open a file" : "Search"}
            placeholder={
              effectiveCategory === "files"
                ? narrow
                  ? "Open a file…"
                  : "Search files by name (or :text to search inside files)"
                : narrow
                  ? "Search…"
                  : "Search sessions, projects, files, actions, settings…"
            }
            value={query}
            clearOnEscape={false}
            onChange={(v) => {
              setQuery(v);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            inputProps={{
              onFocus: takeTyped,
              role: "combobox",
              "aria-expanded": true,
              "aria-controls": `${baseId}-list`,
              "aria-autocomplete": "list",
              ...(flat.length ? { "aria-activedescendant": optionId(current) } : {}),
            }}
          />
          <IconButton icon={X} size="sm" label="Close search" onClick={onClose} className="shrink-0" />
        </div>
        {!filesOnly && (
          <div role="tablist" aria-label="Search category" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 pb-2">
            {visibleCategories.map((c) => {
              const active = category === c.id;
              return (
                <Button
                  key={c.id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={-1}
                  variant="quiet"
                  size="xs"
                  pressed={active}
                  onClick={() => {
                    setCategory(c.id);
                    setSelected(0);
                  }}
                  className={cn("shrink-0 rounded-md px-2.5", active ? "bg-active text-fg" : "text-fg-2 hover:text-fg")}
                >
                  {c.label}
                </Button>
              );
            })}
          </div>
        )}
        <div
          ref={list}
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Results"
          className="octo-popup-fade min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {groups.map((g, gi) => {
            const offset = groupOffsets[gi] ?? 0;
            return (
              <div key={g.title} role="group" aria-labelledby={`${baseId}-${g.title}`} className="pb-1.5 last:pb-0">
                <SectionHeader as="h3" id={`${baseId}-${g.title}`} className="pr-2 pl-2.5">
                  {g.title}
                </SectionHeader>
                {g.items.map((item, ii) => {
                  const i = offset + ii;
                  const isSelected = i === current;
                  const FileIcon = item.filePath ? fileIcon(item.filePath) : null;
                  return (
                    <ListRow
                      key={item.id}
                      id={optionId(i)}
                      role="option"
                      size="md"
                      selected={isSelected}
                      className="rounded-md"
                      onPointerMove={(e) => {
                        if (!gate.current(e) || i === current) return;
                        fromPointer.current = true;
                        setSelected(i);
                      }}
                      onClick={item.run}
                      leading={
                        FileIcon ? (
                          <Glyph icon={FileIcon} size={14} className="text-fg-3" />
                        ) : item.isProject ? (
                          <Glyph icon={FolderGit2} size={14} className="text-fg-3" />
                        ) : item.glyph ? (
                          <StateGlyph state={item.glyph} box={16} />
                        ) : item.pending ? (
                          <Skeleton shape="circle" className="size-3" />
                        ) : (
                          <span />
                        )
                      }
                      title={<Highlight text={item.label} query={highlightQuery} />}
                      tip={item.label}
                      meta={
                        <span className="flex items-center gap-2">
                          {(item.shortcut ?? item.detail) && <span className="truncate">{item.shortcut ?? item.detail}</span>}
                          {isSelected && <Glyph icon={CornerDownLeft} size={12} className="shrink-0 text-fg-3" />}
                        </span>
                      }
                    />
                  );
                })}
              </div>
            );
          })}
          {!flat.length && (
            <p className="px-2 py-6 text-center text-sm text-fg-3">
              {query.trim() ? `No matches for “${query.trim()}”` : effectiveCategory === "files" ? "No files in this project yet" : "No matches"}
            </p>
          )}
        </div>
        {!phone && (
          <div className="flex shrink-0 items-center gap-4 border-t border-line px-3.5 py-2 text-xs text-fg-3">
            <span className="flex items-center gap-1.5">
              Close <KeyHint>Esc</KeyHint>
            </span>
            {!filesOnly && (
              <span className="flex items-center gap-1.5">
                Change type <KeyHint>←</KeyHint>
                <KeyHint>→</KeyHint>
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              Open <KeyHint>↵</KeyHint>
            </span>
          </div>
        )}
        <p role="status" className="sr-only">
          {flat.length === 0 ? "No results" : flat.length === 1 ? "1 result" : `${flat.length} results`}
        </p>
      </div>
    </div>,
    document.body,
  );
}
