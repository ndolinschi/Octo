import { File, type LucideIcon } from "lucide-react";
import { roleText } from "../../lib/orchestrator";
import { GLYPH } from "../primitives/glyphs";
import type { ProjectState } from "@octo/agent-client";
import type { OpenFile } from "../../state/code";
import { middleTruncate } from "../../lib/format";
import { fileIcon } from "../primitives/fileIcons";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { type FileKey, splitKey } from "../../lib/files";
import type { GlyphState } from "../../lib/stateGlyph";

export type TabInfo = {
  /** Shown on the tab (long file names are shortened in the middle). */
  label: string;
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

const TOOLS: Record<string, { label: string; icon: LucideIcon; title: string }> = {
  agents: { label: "Agents", icon: GLYPH.agents, title: "Agents in this project" },
  notes: { label: "Notes", icon: GLYPH.notes, title: "Project notes" },
  files: { label: "Files", icon: GLYPH.files, title: "Project files: select a file to open it here" },
  details: { label: "Details", icon: GLYPH.details, title: "Project details: folders, models, tokens, activity, files written" },
  usage: { label: "Usage", icon: GLYPH.usage, title: "Usage: tokens, cost and rate limits" },
  changes: { label: "Changes", icon: GLYPH.changes, title: "Changes: what the agents changed in this project, with diffs and revert" },
  memory: { label: "Memory", icon: GLYPH.memory, title: "Memory: what the orchestrator remembers about this project" },
  side: { label: "Side question", icon: GLYPH.side, title: "Ask about this project without interrupting the orchestrator" },
};

function firstWords(text: string, n = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

/** The tool tabs as the "+" picker lists them (decision 25), in that order. */
export const TOOL_TABS = TOOLS;

export function tabInfo(
  tab: TabId,
  ctx: {
    state: ProjectState;
    projectName?: string | undefined;
    orchestratorId: string | undefined;
    file(key: FileKey): OpenFile | undefined;
    comments(key: FileKey): number;
  },
): TabInfo {
  const ref = parseTab(tab);
  if (!ref) return { label: tab, title: tab, icon: File, status: null, glyph: null, comments: 0 };
  if (ref.kind === "chat") {
    const status = ctx.orchestratorId ? ctx.state.agents[ctx.orchestratorId]?.status : undefined;
    const running = status === "running";
    // Decision 63: named after what is in it — the project's conversation.
    const name = ctx.projectName || "Conversation";
    return {
      label: middleTruncate(name, 28),
      name,
      title: `${name}: the project's conversation`,
      icon: GLYPH.chat,
      status: running ? "running" : null,
      glyph: running ? "working" : status === "failed" ? "needs" : null,
      comments: 0,
    };
  }
  if (ref.kind === "tool") {
    const tool = TOOLS[ref.tool];
    return tool ? { ...tool, status: null, glyph: null, comments: 0 } : { label: tab, title: tab, icon: File, status: null, glyph: null, comments: 0 };
  }
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
