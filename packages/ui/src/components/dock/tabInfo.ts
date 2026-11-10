import { Bot, File, FolderTree, MessagesSquare, NotebookText, Workflow, type LucideIcon } from "lucide-react";
import type { ProjectState } from "@octo/agent-client";
import type { OpenFile } from "../../state/code";
import { middleTruncate } from "../../lib/format";
import { parseTab, type TabId } from "../../state/workspace/layout";

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
};

const TOOLS: Record<string, { label: string; icon: LucideIcon; title: string }> = {
  agents: { label: "Agents", icon: Workflow, title: "Agents in this project" },
  notes: { label: "Notes", icon: NotebookText, title: "Project notes" },
  files: { label: "Files", icon: FolderTree, title: "Project files" },
};

export function tabInfo(tab: TabId, ctx: { state: ProjectState; orchestratorId: string | undefined; file(key: string): OpenFile | undefined }): TabInfo {
  const ref = parseTab(tab);
  if (!ref) return { label: tab, title: tab, icon: File, status: null };
  if (ref.kind === "chat") {
    const running = ctx.orchestratorId ? ctx.state.agents[ctx.orchestratorId]?.status === "running" : false;
    return { label: "Chat", title: "Chat with the orchestrator", icon: MessagesSquare, status: running ? "running" : null };
  }
  if (ref.kind === "tool") return { ...TOOLS[ref.tool], status: null };
  if (ref.kind === "agent") {
    const agent = ctx.state.agents[ref.agentId];
    const label = agent?.role || "Agent";
    return {
      label,
      title: agent?.title ? `${label}: ${agent.title}` : label,
      icon: Bot,
      status: agent?.status === "running" ? "running" : null,
    };
  }
  const f = ctx.file(ref.key);
  const i = ref.key.indexOf("\u0000");
  const path = ref.key.slice(i + 1);
  const name = f?.name ?? path.slice(path.lastIndexOf("/") + 1);
  return {
    // Long names lose their middle, so the extension (and path tail) stay readable.
    label: middleTruncate(name, 28),
    name,
    title: middleTruncate(`${ref.key.slice(0, i)}/${path}`, 96),
    icon: File,
    status: f?.modified ? "modified" : null,
  };
}
