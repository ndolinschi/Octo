import type { Agent, Folder, ProjectSession, Workspace } from "@octo/agent-client";
import { fileName } from "../../lib/files";

export type SessionFolderItem = {
  id: string;
  label: string;
  path: string;
  /** Folders matching a project folder can be revealed in the Files tree (`code.revealDir`). */
  revealable: boolean;
};

/**
 * Agents belonging to `sessionId`, in `order`: returns every agent when `sessionId` is null (older harnesses without
 * parallel sessions). When `sessionId` is set, matches `agent.session_id === sessionId` and, for legacy or sub-agent rows
 * missing `session_id`, walks `parent_id` up to an ancestor with `session_id` or to `rootAgentId`.
 */
export function agentsInSession(
  agents: Readonly<Record<string, Agent | undefined>>,
  order: readonly string[],
  sessionId: string | null,
  rootAgentId?: string,
): Agent[] {
  const ordered: Agent[] = [];
  for (const id of order) {
    const a = agents[id];
    if (a) ordered.push(a);
  }
  if (sessionId === null) return ordered;

  const memo = new Map<string, boolean>();
  const belongs = (agent: Agent): boolean => {
    const cached = memo.get(agent.id);
    if (cached !== undefined) return cached;
    if (agent.session_id) {
      const ok = agent.session_id === sessionId;
      memo.set(agent.id, ok);
      return ok;
    }
    const chain: Agent[] = [];
    const seen = new Set<string>();
    let cur: Agent | undefined = agent;
    let ok = false;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const hit = memo.get(cur.id);
      if (hit !== undefined) {
        ok = hit;
        break;
      }
      chain.push(cur);
      if (cur.session_id) {
        ok = cur.session_id === sessionId;
        break;
      }
      if (rootAgentId && cur.id === rootAgentId) {
        ok = true;
        break;
      }
      cur = cur.parent_id ? agents[cur.parent_id] : undefined;
    }
    for (const node of chain) memo.set(node.id, ok);
    return ok;
  };

  return ordered.filter(belongs);
}

/** Filters stored messages for `sessionId` when `m.session_id` is recorded (untagged messages stay when agent matched). */
export function filterMessagesForSession<T extends { session_id?: string }>(messages: readonly T[], sessionId: string | null): T[] {
  if (sessionId === null) return [...messages];
  return messages.filter((m) => !m.session_id || m.session_id === sessionId);
}

/** Newest agent among `agents` that carries a router placement (`route_choice`). */
export function latestRoutedAgent(agents: readonly Agent[]): Agent | undefined {
  return [...agents].filter((a) => Boolean(a.route_choice)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

/**
 * Folders and workspace badge for the active session. When the session runs in its own isolated checkout and `workspaces`
 * has loaded it, returns that checkout's folder paths; otherwise falls back to `projectFolders`. Never emits the word
 * "worktree" in user-facing text (`words.ts`).
 */
export function resolveSessionFolders(
  projectFolders: readonly Folder[],
  session?: Pick<ProjectSession, "workspace"> | null,
  workspaces?: readonly Workspace[],
): { folders: SessionFolderItem[]; workspaceTag: string | null } {
  const wsMeta = session?.workspace;
  const fallback = projectFolders.map<SessionFolderItem>((f) => ({
    id: f.id,
    label: f.label,
    path: f.path,
    revealable: true,
  }));

  if (!session) return { folders: fallback, workspaceTag: null };

  if (wsMeta?.kind !== "worktree") {
    return { folders: fallback, workspaceTag: "Main checkout" };
  }

  const branch = wsMeta.branch?.trim();
  const title = wsMeta.title?.trim();
  const safeTitle = title && !/\bworktrees?\b/i.test(title) ? title : undefined;
  const workspaceTag = branch || safeTitle || "Isolated branch";

  const matched = workspaces?.find((w) => w.id === wsMeta.id);
  if (!matched || matched.folders.length === 0) {
    return { folders: fallback, workspaceTag };
  }

  const folders = matched.folders.map<SessionFolderItem>((wf) => {
    const pf = projectFolders.find((p) => p.id === wf.folder_id);
    const label = wf.folder_label?.trim() || pf?.label || fileName(wf.path) || wf.folder_id;
    const revealable = pf !== undefined || projectFolders.some((p) => p.label === label);
    return {
      id: wf.folder_id || wf.path,
      label,
      path: wf.path,
      revealable,
    };
  });

  return { folders, workspaceTag };
}
