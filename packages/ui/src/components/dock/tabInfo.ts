import { File, type LucideIcon } from "lucide-react";
import { currentTitle } from "../../lib/sessions/current";
import { roleText } from "../../lib/orchestrator";
import { GLYPH } from "../primitives/glyphs";
import { sessionRoot, type ProjectState } from "@octo/agent-client";
import type { OpenFile } from "../../state/code";
import { middleTruncate } from "../../lib/format";
import { fileIcon } from "../primitives/fileIcons";
import { parseTab, type TabId, type ToolTab } from "../../state/workspace/layout";
import { TOOL_PURPOSE } from "../../lib/toolPurpose";
import { type FileKey, splitKey } from "../../lib/files";
import type { GlyphState } from "../../lib/stateGlyph";

export type TabInfo = {
  /** Shown on the tab (long file names are shortened in the middle). */
  label: string;
  /** Dim second part after the label ("Project / what this conversation is about", decision 67). */
  detail?: string;
  /** Full name: the tab's accessible name. */
  name?: string;
  /** Tooltip: the full name (path for files, role and title for agents). */
  title: string;
  icon: LucideIcon;
  /** Trailing state: unsaved edits (grey dot); "running" is kept for the screen-reader suffix. */
  status: "running" | "modified" | null;
  /** Decision 29: an Orchestrator / Agent tab shows its state ring in place of the kind icon while not idle. */
  glyph: GlyphState | null;
  /** Pending code comments on this file. */
  comments: number;
};

/** The tooltip of a tool tab is its name and its purpose (one source with the panels' (i) and the palette: `lib/toolPurpose`). */
const tool = (label: string, icon: LucideIcon, purpose: string) => ({ label, icon, title: `${label}: ${purpose}` });

const TOOLS: Record<ToolTab, { label: string; icon: LucideIcon; title: string }> = {
  sessions: tool("Sessions", GLYPH.sessions, TOOL_PURPOSE.sessions),
  agents: tool("Agents", GLYPH.agents, TOOL_PURPOSE.agents),
  notes: tool("Notes", GLYPH.notes, TOOL_PURPOSE.notes),
  files: tool("Files", GLYPH.files, TOOL_PURPOSE.files),
  browser: tool("Browser", GLYPH.browser, TOOL_PURPOSE.browser),
  terminal: tool("Terminal", GLYPH.terminal, TOOL_PURPOSE.terminal),
  processes: tool("Processes", GLYPH.processes, TOOL_PURPOSE.processes),
  details: tool("Details", GLYPH.details, TOOL_PURPOSE.details),
  usage: tool("Usage", GLYPH.usage, TOOL_PURPOSE.usage),
  changes: tool("Changes", GLYPH.changes, TOOL_PURPOSE.changes),
  memory: tool("Memory", GLYPH.memory, TOOL_PURPOSE.memory),
  review: tool("Review", GLYPH.review, TOOL_PURPOSE.review),
  side: tool("Side question", GLYPH.side, TOOL_PURPOSE.side),
};

function firstWords(text: string, n = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

function browserTabInfo(b?: { url: string; title: string; pins: number }): TabInfo {
  const clean = b?.title.trim() ?? "";
  const url = b?.url ?? "";
  let host = "";
  try {
    if (url) host = new URL(url).host;
  } catch {
    host = url.trim();
  }
  const label = clean || host || "Browser";
  const detail = clean && host ? host : undefined;
  const full = clean ? (url ? `${clean} — ${url}` : clean) : host ? url : TOOL_PURPOSE.browser;
  return {
    label,
    ...(detail ? { detail } : {}),
    name: full,
    title: `Browser: ${full}`,
    icon: GLYPH.browser,
    status: null,
    glyph: null,
    comments: b?.pins ?? 0,
  };
}

function terminalTabInfo(t?: { shell: string; folder: string; title: string }): TabInfo {
  const shell = t?.shell.trim() || "Terminal";
  const folder = t?.folder.trim() ?? "";
  const custom = t?.title.trim() ?? "";
  const label = custom || shell;
  const detail = !custom && folder ? folder : undefined;
  const full = detail ? `${label} · ${detail}` : label;
  return {
    label,
    ...(detail ? { detail } : {}),
    name: full,
    title: `Terminal: ${full}`,
    icon: GLYPH.terminal,
    status: null,
    glyph: null,
    comments: 0,
  };
}

type ConversationCtx = { state: ProjectState; projectName?: string | undefined; orchestratorId: string | undefined };

/**
 * A conversation tab: Chat, or a main session's own tab (decision 96). Decision 63/67: named after the project, the dim part
 * the session ("Project / Session"); the state ring is its root agent's.
 */
function conversationInfo(ctx: ConversationCtx, sessionId: string | null): TabInfo {
  const root = (sessionId !== null ? sessionRoot(ctx.state, sessionId) : "") || (sessionId === ctx.state.sessions.defaultId ? ctx.orchestratorId : undefined);
  const status = root ? ctx.state.agents[root]?.status : undefined;
  const running = status === "running";
  const name = ctx.projectName || "Session";
  // The session's title (project sessions), else its root's own.
  const own = root ? (ctx.state.agents[root]?.title?.trim() ?? "") : "";
  const topic = currentTitle(ctx.state.sessions.list, sessionId, own).trim();
  const detail = topic && topic !== name ? middleTruncate(topic, 40) : undefined;
  const queued = sessionId !== null && ctx.state.sessions.list.find((x) => x.id === sessionId)?.state === "queued";
  return {
    label: middleTruncate(name, 28),
    ...(detail ? { detail } : {}),
    name: detail ? `${name} / ${topic}` : name,
    title: `${name}: the project's session${topic ? ` — ${topic}` : ""}`,
    icon: GLYPH.chat,
    status: running ? "running" : null,
    glyph: running ? "working" : status === "failed" ? "needs" : queued ? "queued" : null,
    comments: 0,
  };
}

/** The tool tabs as the "+" picker lists them (decision 25), in that order. */
export const TOOL_TABS = TOOLS;

export function tabInfo(
  tab: TabId,
  ctx: {
    state: ProjectState;
    projectName?: string | undefined;
    orchestratorId: string | undefined;
    /** Decision 96: the main session the conversation tab (Chat) shows; null: the default one. */
    chatSessionId?: string | null;
    file(key: FileKey): OpenFile | undefined;
    comments(key: FileKey): number;
    /** The state of a project command's latest run (decision 68). */
    runStatus(name: string): "running" | "failed" | null;
    /** Browser tab metadata (URL, document title, pending Design Mode pin count). */
    browser?(browserId: string): { url: string; title: string; pins: number } | undefined;
    /** Terminal tab metadata (shell name, folder label, optional title). */
    terminal?(terminalId: string): { shell: string; folder: string; title: string } | undefined;
  },
): TabInfo {
  const ref = parseTab(tab);
  if (!ref) return { label: tab, title: tab, icon: File, status: null, glyph: null, comments: 0 };
  if (ref.kind === "chat") return conversationInfo(ctx, ctx.chatSessionId ?? ctx.state.sessions.defaultId);
  if (ref.kind === "tool") {
    if (ref.tool === "browser") {
      const b = ctx.browser?.("default");
      if (b && (b.url || b.title || b.pins > 0)) return browserTabInfo(b);
    }
    if (ref.tool === "terminal") {
      const t = ctx.terminal?.("default");
      if (t && (t.shell || t.folder || t.title)) return terminalTabInfo(t);
    }
    return { ...TOOLS[ref.tool], status: null, glyph: null, comments: 0 };
  }
  if (ref.kind === "browser") return browserTabInfo(ctx.browser?.(ref.browserId));
  if (ref.kind === "terminal") return terminalTabInfo(ctx.terminal?.(ref.terminalId));
  if (ref.kind === "agent") {
    const agent = ctx.state.agents[ref.agentId];
    // Decision 63: a sub-agent's tab is its task title (else the first words of its task), the role in the tooltip.
    const task = agent?.title || firstWords(agent?.task ?? "") || roleText(agent?.role);
    return {
      label: middleTruncate(task, 28),
      name: task,
      title: `${roleText(agent?.role)}: ${task}`,
      icon: GLYPH.agent,
      status: agent?.status === "running" ? "running" : null,
      glyph: agent?.status === "running" ? "working" : agent?.status === "failed" ? "failed" : null,
      comments: 0,
    };
  }
  if (ref.kind === "session") {
    const s = ctx.state.sessions.list.find((x) => x.id === ref.sessionId);
    if (s?.kind === "agent") {
      const title = s.title.trim() || "Session";
      const working = s.state === "working" || s.state === "waiting";
      return {
        label: middleTruncate(title, 28),
        name: title,
        title: `Agent session: ${title}`,
        icon: GLYPH.sessions,
        status: working ? "running" : null,
        glyph: working ? "working" : s.state === "failed" ? "failed" : null,
        comments: 0,
      };
    }
    const root = sessionRoot(ctx.state, ref.sessionId);
    const status = root ? ctx.state.agents[root]?.status : undefined;
    const running = status === "running" || s?.state === "working";
    const failed = status === "failed" || s?.state === "failed";
    const waiting = s?.state === "waiting" || s?.needs_you === true;
    const queued = s?.state === "queued";
    const own = root ? (ctx.state.agents[root]?.title?.trim() ?? "") : "";
    const topic = currentTitle(ctx.state.sessions.list, ref.sessionId, own).trim() || "New session";
    const projectLabel = ctx.projectName || "Session";
    return {
      label: middleTruncate(topic, 28),
      name: topic,
      title: `${projectLabel}: ${topic}`,
      icon: GLYPH.chat,
      status: running ? "running" : null,
      glyph: running ? "working" : failed || waiting ? "needs" : queued ? "queued" : null,
      comments: 0,
    };
  }
  if (ref.kind === "run") {
    const status = ctx.runStatus(ref.name);
    const label = `Run: ${ref.name}`;
    return {
      label,
      title: label,
      icon: GLYPH.run,
      status: status === "running" ? "running" : null,
      glyph: status === "running" ? "working" : status,
      comments: 0,
    };
  }
  const f = ctx.file(ref.key);
  const { folder, path } = splitKey(ref.key);
  const name = f?.name ?? path.slice(path.lastIndexOf("/") + 1);
  return {
    // Long names lose their middle, so the extension (and path tail) stay readable.
    label: middleTruncate(name, 22),
    name,
    title: middleTruncate(`${folder}/${path}`, 96),
    icon: fileIcon(name),
    status: f?.modified ? "modified" : null,
    glyph: null,
    comments: ctx.comments(ref.key),
  };
}
