import { File, type LucideIcon } from "lucide-react";
import { GLYPH } from "../primitives/glyphs";
import type { ProjectState } from "@octo/agent-client";
import type { OpenFile } from "../../state/code";
import { middleTruncate } from "../../lib/format";
import { fileIcon } from "../primitives/fileIcons";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { type FileKey, splitKey } from "../../lib/files";

export type TabInfo = {
  /** Shown on the tab (long file names are shortened in the middle). */
  label: string;
  /** Full name: the tab's accessible name. */
  name?: string;
  /** Tooltip: the full name (path for files, role and title for agents). */
  title: string;
  icon: LucideIcon;
  /** Trailing state: a working agent (accent dot) or unsaved edits (grey dot). */
  status: "running" | "modified" | null;
  /** Pending code comments on this file. */
  comments: number;
};

const TOOLS: Record<string, { label: string; icon: LucideIcon; title: string }> = {
  agents: { label: "Agents", icon: GLYPH.agents, title: "Agents in this project" },
  notes: { label: "Notes", icon: GLYPH.notes, title: "Project notes" },
  files: { label: "Files", icon: GLYPH.files, title: "Project files: select a file to open it here" },
  details: { label: "Details", icon: GLYPH.details, title: "Project details: folders, models, tokens, activity, files written" },
  usage: { label: "Usage", icon: GLYPH.usage, title: "Usage: tokens, cost and rate limits" },
};

export function tabInfo(
  tab: TabId,
  ctx: { state: ProjectState; orchestratorId: string | undefined; file(key: FileKey): OpenFile | undefined; comments(key: FileKey): number },
): TabInfo {
  const ref = parseTab(tab);
  if (!ref) return { label: tab, title: tab, icon: File, status: null, comments: 0 };
  if (ref.kind === "chat") {
    const running = ctx.orchestratorId ? ctx.state.agents[ctx.orchestratorId]?.status === "running" : false;
    return {
      label: "Orchestrator",
      title: "The project's orchestrator: give it work, follow its agents",
      icon: GLYPH.chat,
      status: running ? "running" : null,
      comments: 0,
    };
  }
  if (ref.kind === "tool") {
    const tool = TOOLS[ref.tool];
    return tool ? { ...tool, status: null, comments: 0 } : { label: tab, title: tab, icon: File, status: null, comments: 0 };
  }
  if (ref.kind === "agent") {
    const agent = ctx.state.agents[ref.agentId];
    const label = agent?.role || "Agent";
    return {
      label,
      title: agent?.title ? `${label}: ${agent.title}` : label,
      icon: GLYPH.agent,
      status: agent?.status === "running" ? "running" : null,
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
    comments: ctx.comments(ref.key),
  };
}
