import type { Agent } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
import { FileSearch, Plus, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { errorMessage, structuredError } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { MOD_LABEL } from "../../lib/keys";
import { filterSections, type PickerRow, type PickerSection } from "../../lib/picker";
import { navigate } from "../../lib/route";
import { sessionChoiceMeta, sessionChoices } from "../../lib/sessions/picker";
import { sessionGlyph, sessionTitle } from "../../lib/sessions/tree";
import { agentGlyph } from "../../lib/stateGlyph";
import { useApp } from "../../state/app";
import { useCode } from "../../state/code";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useOptionalComments } from "../../state/comments";
import { getBrowserTabPins, getBrowserTabState, useBrowserTabsRevision } from "../../state/browserTabs";
import { getTerminalTabState, useTerminalTabsRevision } from "../../state/terminalTabs";
import { getPlanTabState, usePlanTabsRevision } from "../../state/planTabs";
import { allTabs, CHAT, parseTab, sessionTab, toolTab, type ToolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { Notice } from "../primitives/Notice";
import { GLYPH } from "../primitives/glyphs";
import { Picker } from "../primitives/Picker";
import { StateGlyph } from "../primitives/StateGlyph";
import { useShowFiles } from "../files/useShowFiles";
import { useCreateProjectSession, useSyncProjectSessions } from "../shell/sessionSwitcher";
import { tabInfo, TOOL_TABS } from "./tabInfo";

const AGENTS_SHOWN = 6;
const FILES_SHOWN = 6;
const SESSIONS_SHOWN = 6;
const RECENT_SHOWN = 6;

type SearchableFile = { folder: string; path: string; lower: string };

/** Picks up to `limit` shortest-path matching files in a single O(N) pass without sorting the whole match list. */
function topMatchingFiles(files: readonly SearchableFile[], q: string, limit: number): SearchableFile[] {
  const top: SearchableFile[] = [];
  for (const f of files) {
    if (!f.lower.includes(q)) continue;
    const len = f.path.length;
    const last = top[limit - 1];
    if (top.length < limit) {
      top.push(f);
    } else if (last && len < last.path.length) {
      top[limit - 1] = f;
    } else {
      continue;
    }
    let j = top.length - 1;
    while (j > 0) {
      const prev = top[j - 1];
      if (!prev || prev.path.length <= len) break;
      top[j] = prev;
      j--;
    }
    top[j] = f;
  }
  return top;
}

/**
 * The "+" at the end of a strip (and `Ctrl/Cmd+T`, decision 25): one searchable list — recent tabs (closed and MRU),
 * the tools (Agents, Notes, Files, Details, Usage, Side question), "Open file…" and, once something is typed, matching
 * project files; project sessions and "New session"; running and recent agents; the project's settings and
 * "Open in editor". This replaces the tool buttons the strip used to carry (decision 24: the strip carries tabs only).
 */
export function TabPicker({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const { projects, bridge } = useApp();
  const ws = useWorkspace();
  const code = useCode();
  const files = useShowFiles();
  const { state, project, projectId } = useProject();
  const browserRev = useBrowserTabsRevision(projectId);
  const terminalRev = useTerminalTabsRevision(projectId);
  const planRev = usePlanTabsRevision(projectId);
  const commentCounts = useOptionalComments()?.counts;
  const { openProjectInEditor } = useHost();
  const createSession = useCreateProjectSession();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(false, CLOCK_MINUTE_MS);
  const { indexFiles, fileIndex, loadedFiles, file: codeFile, openFile } = code;
  // Defer background file indexing until after the popover has painted (or immediately when the user starts typing).
  useEffect(() => {
    if (fileIndex.status === "done") return;
    const t = window.setTimeout(() => indexFiles(), 150);
    return () => window.clearTimeout(t);
  }, [fileIndex.status, indexFiles]);
  useSyncProjectSessions(Boolean(project));
  const open = useMemo(() => new Set(allTabs(ws.layout)), [ws.layout]);

  const searchableFiles = useMemo<SearchableFile[]>(
    () => loadedFiles.map((f) => ({ folder: f.folder, path: f.path, lower: `${f.folder}/${f.path}`.toLowerCase() })),
    [loadedFiles],
  );

  const agents = useMemo(() => {
    const list = state.agentOrder.flatMap((id) => {
      const a = state.agents[id];
      return a && a.parent_id !== null ? [a] : [];
    });
    const rank = (a: Agent) => (a.status === "running" ? 1 : 0);
    return list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at)).slice(0, AGENTS_SHOWN);
  }, [state.agentOrder, state.agents]);

  const handleNewSession = useCallback(async () => {
    if (creating) return;
    setError(null);
    setCreating(true);
    try {
      const created = await createSession("tab");
      if (created) onClose();
      else setCreating(false);
    } catch (e) {
      setError(structuredError(e)?.message ?? errorMessage(e));
      setCreating(false);
    }
  }, [creating, createSession, onClose]);

  const handleNewSessionInProject = useCallback(
    async (targetProjectId: string) => {
      if (creating) return;
      setError(null);
      setCreating(true);
      try {
        const { session } = await bridge.createSession(targetProjectId, {});
        onClose();
        navigate(targetProjectId, null, session.id);
      } catch (e) {
        setError(structuredError(e)?.message ?? errorMessage(e));
        setCreating(false);
      }
    },
    [creating, bridge, onClose],
  );

  const commands = useMemo(() => new Set((project?.commands ?? []).map((c) => c.name.toLowerCase())), [project?.commands]);
  const knownSessions = useMemo(() => (state.sessions.list.length > 0 ? new Set(state.sessions.list.map((s) => s.id)) : null), [state.sessions.list]);

  const recentRows = useMemo<PickerRow[]>(() => {
    void browserRev;
    void terminalRev;
    void planRev;
    const infoCtx = {
      state,
      projectName: project?.name,
      orchestratorId: project?.orchestrator_agent_id,
      chatSessionId: ws.chatSessionId,
      file: codeFile,
      comments: (key: Parameters<typeof codeFile>[0]) => commentCounts?.get(key) ?? 0,
      runStatus: (name: string) => ws.runStatuses[name.toLowerCase()] ?? null,
      browser: (id: string) => {
        const b = getBrowserTabState(projectId, id);
        return { url: b.url, title: b.title, pins: getBrowserTabPins(projectId, id) };
      },
      terminal: (id: string) => getTerminalTabState(projectId, id),
      plan: (id: string) => getPlanTabState(projectId, id),
    };
    return ws
      .recentTabs()
      .filter(({ tab }) => {
        if (tab === CHAT) return false;
        const ref = parseTab(tab);
        if (!ref) return false;
        if (ref.kind === "tool" && !ws.toolEnabled(ref.tool)) return false;
        if (ref.kind === "browser" && !ws.toolEnabled("browser")) return false;
        if (ref.kind === "terminal" && !ws.toolEnabled("terminal")) return false;
        if (ref.kind === "agent" && !state.agents[ref.agentId]) return false;
        if (ref.kind === "session" && knownSessions && !knownSessions.has(ref.sessionId)) return false;
        if (ref.kind === "run" && !commands.has(ref.name.toLowerCase())) return false;
        return true;
      })
      .slice(0, RECENT_SHOWN)
      .map(({ tab }) => {
        const info = tabInfo(tab, infoCtx);
        return {
          id: `recent:${tab}`,
          label: info.label,
          ...(info.detail ? { detail: info.detail } : {}),
          lead: info.glyph ? <StateGlyph state={info.glyph} size={12} box={16} /> : <Glyph icon={info.icon} size={14} />,
          title: info.title,
          run: () => ws.reopenTab(tab),
        };
      });
  }, [browserRev, terminalRev, planRev, state, project?.name, project?.orchestrator_agent_id, ws, codeFile, commentCounts, projectId, knownSessions, commands]);

  const toolRows = useMemo<PickerRow[]>(() => {
    const tools: PickerRow[] = (Object.entries(TOOL_TABS) as [ToolTab, (typeof TOOL_TABS)[ToolTab]][])
      .filter(([tool]) => ws.toolEnabled(tool))
      .map(([tool, t]) => ({
        id: `tool:${tool}`,
        label: t.label,
        lead: <Glyph icon={t.icon} size={14} />,
        ...(open.has(toolTab(tool)) ? { detail: "open" } : {}),
        ...(tool === "side" ? { hint: `${MOD_LABEL};` } : tool === "terminal" ? { hint: `${MOD_LABEL}\`` } : {}),
        title: t.title,
        run: () => (tool === "files" ? files.show() : ws.openTool(tool)),
      }));
    if (ws.toolEnabled("files")) {
      tools.push({ id: "open-file", label: "Open file…", lead: <Glyph icon={FileSearch} size={14} />, title: "Filter the project's files", run: files.show });
    }
    if (ws.toolEnabled("browser")) {
      tools.push({
        id: "new-browser",
        label: "New browser tab",
        lead: <Glyph icon={GLYPH.browser} size={14} />,
        title: "Open another browser tab",
        run: () => ws.openBrowser({ newTab: true }),
      });
    }
    if (ws.toolEnabled("terminal")) {
      tools.push({
        id: "new-terminal",
        label: "New terminal tab",
        lead: <Glyph icon={GLYPH.terminal} size={14} />,
        hint: `${MOD_LABEL}Shift+\``,
        title: "Open another interactive terminal tab",
        run: () => ws.openTerminal({ newTab: true }),
      });
    }
    return tools;
  }, [ws, open, files]);

  const allMains = useMemo(() => sessionChoices(state.sessions.list), [state.sessions.list]);
  const otherProjects = useMemo(() => (projects ?? []).filter((p) => p.id !== projectId), [projects, projectId]);

  const agentRows = useMemo<PickerRow[]>(
    () =>
      agents.map((a) => ({
        id: `agent:${a.id}`,
        label: roleText(a.role),
        detail: a.title,
        lead: <StateGlyph state={agentGlyph(a.status)} />,
        title: a.title ? `${a.role}: ${a.title}` : a.role,
        run: () => ws.openAgent(a.id),
      })),
    [agents, ws],
  );

  const projectRows = useMemo<PickerRow[]>(
    () => [
      { id: "settings", label: "Project settings", lead: <Glyph icon={GLYPH.settings} size={14} />, run: ws.openSettings },
      ...(openProjectInEditor && project && project.folders.length > 0
        ? [{ id: "editor", label: "Open in editor", lead: <Glyph icon={SquareArrowOutUpRight} size={14} />, run: () => openProjectInEditor(project.id) }]
        : []),
    ],
    [ws.openSettings, openProjectInEditor, project],
  );

  const onQuery = useCallback(
    (q: string) => {
      if (q.trim() !== "") indexFiles();
    },
    [indexFiles],
  );

  const sections = useCallback(
    (query: string): PickerSection[] => {
      const q = query.trim().toLowerCase();
      const fileRows: PickerRow[] = q
        ? topMatchingFiles(searchableFiles, q, FILES_SHOWN).map((f) => ({
            id: `file:${f.folder}/${f.path}`,
            label: f.path.slice(f.path.lastIndexOf("/") + 1),
            detail: `${f.folder}/${f.path.slice(0, Math.max(0, f.path.lastIndexOf("/")))}`.replace(/\/$/, ""),
            lead: <Glyph icon={fileIcon(f.path)} size={14} />,
            title: `${f.folder}/${f.path}`,
            run: () => openFile(f.folder, f.path),
          }))
        : [];
      const activeId = ws.chatSessionId ?? state.sessions.defaultId;
      const shownMains = q ? allMains : allMains.slice(0, SESSIONS_SHOWN);
      const sessionRows: PickerRow[] = [
        ...shownMains.map<PickerRow>((s) => ({
          id: `session:${s.id}`,
          label: sessionTitle(s),
          lead: <StateGlyph state={sessionGlyph(s)} size={12} box={16} />,
          ...sessionChoiceMeta(s, { activeId, openTab: open.has(sessionTab(s.id)), now, markActiveHint: true }),
          run: () => ws.openSession(s.id),
        })),
        {
          id: "new-session",
          label: project ? `New session in ${project.name}` : "New session",
          detail: "Open in new tab",
          lead: <Glyph icon={Plus} size={14} />,
          keepOpen: true,
          busy: creating,
          disabled: creating,
          run: () => void handleNewSession(),
        },
        ...otherProjects.map<PickerRow>((p) => ({
          id: `new-session:${p.id}`,
          label: `New session in ${p.name}`,
          detail: "Switch project",
          lead: <Glyph icon={Plus} size={14} />,
          keepOpen: true,
          busy: creating,
          disabled: creating,
          run: () => void handleNewSessionInProject(p.id),
        })),
      ];
      // Files are matched by the query already; the other sections are filtered by it.
      const rest = filterSections(
        [
          ...(recentRows.length > 0 ? [{ title: "Recent", rows: recentRows }] : []),
          { title: "Open", rows: toolRows },
          { title: "Sessions", rows: sessionRows },
          { title: "Agents", rows: agentRows },
          { title: "Project", rows: projectRows },
        ],
        query,
      );
      if (!fileRows.length) return rest;
      const openIdx = rest.findIndex((s) => s.title === "Open");
      const insertAt = openIdx >= 0 ? openIdx + 1 : 1;
      return [...rest.slice(0, insertAt), { title: "Files", rows: fileRows }, ...rest.slice(insertAt)];
    },
    [
      searchableFiles,
      openFile,
      ws,
      state.sessions.defaultId,
      allMains,
      open,
      now,
      project,
      creating,
      handleNewSession,
      otherProjects,
      handleNewSessionInProject,
      recentRows,
      toolRows,
      agentRows,
      projectRows,
    ],
  );

  return (
    <Picker
      anchor={anchor}
      label="Open a tab"
      placeholder="Open a tool, session, file or agent"
      sections={sections}
      onQuery={onQuery}
      onClose={onClose}
      align="start"
      footer={
        error ? (
          <div className="border-t border-line px-3 py-2">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : undefined
      }
    />
  );
}
