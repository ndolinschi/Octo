import type { Agent, ProjectSession, ProjectSessionState } from "@octo/agent-client";
import type { GlyphState } from "../stateGlyph";
import { formatDay, formatWhen } from "../memory/dates";
import { exchangeCount } from "../memory/sessions";
import { startedMs } from "./current";

export { currentTitle, transcriptSession } from "./current";

/** The Sessions tab's filters (decision 5): everything, what works now, the conversations, the agents, the archive. */
export type SessionFilter = "all" | "working" | "mine" | "agents" | "archived";

export const FILTERS: readonly { id: SessionFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Conversations with the orchestrator and the agent sessions they started" },
  { id: "working", label: "Working", title: "Sessions that are working or waiting for you" },
  { id: "mine", label: "Mine", title: "Your conversations with the orchestrator" },
  { id: "agents", label: "Agents", title: "Sessions of the agents the orchestrator started" },
  { id: "archived", label: "Archived", title: "Archived sessions" },
];

/** A main session with the agent sessions it started (oldest first), or one agent session on its own (`children` empty). */
export type SessionNode = { session: ProjectSession; children: ProjectSession[] };

const newest = (a: ProjectSession, b: ProjectSession): number => startedMs(b) - startedMs(a);
const oldest = (a: ProjectSession, b: ProjectSession): number => startedMs(a) - startedMs(b);

export const isWorking = (s: Pick<ProjectSession, "state">): boolean => s.state === "working" || s.state === "waiting";

/**
 * "Delete" is offered on a session that is not the current one and has nothing running (itself or, for a main session,
 * an agent session it started). The harness refuses the rest with `current_session` / `session_running`.
 */
export function canDelete(list: readonly ProjectSession[], s: ProjectSession): boolean {
  if (s.kind === "main" && s.current) return false;
  if (isWorking(s)) return false;
  return s.kind === "agent" || !list.some((x) => x.kind === "agent" && x.parent_session_id === s.id && isWorking(x));
}

/** The confirmation before a delete: what goes, and what stays (decision 95 c). Memory's entries are not deleted with a session. */
export function deleteCopy(s: Pick<ProjectSession, "kind">): { title: string; description: string } {
  return s.kind === "main"
    ? {
        title: "Delete this session?",
        description:
          "Its transcript and the sessions of the agents it started are deleted. What the project remembered from it stays, marked as from a deleted session. This cannot be undone.",
      }
    : {
        title: "Delete this agent session?",
        description: "This agent's transcript is deleted. Your conversation and what the project remembered stay as they are. This cannot be undone.",
      };
}

/** A main session that nobody has asked anything yet (a new one, or one just made by `/clear`): idle with no exchange. */
export const hasNoRequests = (s: Pick<ProjectSession, "kind" | "state" | "exchanges">): boolean => s.kind === "main" && s.state === "idle" && s.exchanges === 0;

function childrenOf(list: readonly ProjectSession[], main: ProjectSession, keep: (s: ProjectSession) => boolean): ProjectSession[] {
  return list.filter((s) => s.kind === "agent" && s.parent_session_id === main.id && keep(s)).sort(oldest);
}

/**
 * What a filter shows, in order. `all`: the main sessions newest first, each with its agent sessions; `working`: the main
 * sessions that work or wait, and a main session that is idle but has a working agent shows just those agents; `mine`: the
 * main sessions alone; `agents`: every agent session on its own, newest first (only those of main session `agentsOf` when
 * given); `archived`: archived sessions of both kinds.
 */
export function visibleNodes(list: readonly ProjectSession[], filter: SessionFilter, agentsOf: string | null = null): SessionNode[] {
  const live = (s: ProjectSession) => !s.archived;
  const mains = list.filter((s) => s.kind === "main");
  switch (filter) {
    case "all":
      return mains
        .filter(live)
        .sort(newest)
        .map((m) => ({ session: m, children: childrenOf(list, m, live) }));
    case "mine":
      return mains
        .filter(live)
        .sort(newest)
        .map((m) => ({ session: m, children: [] }));
    case "agents":
      return list
        .filter((s) => s.kind === "agent" && live(s) && (agentsOf === null || s.parent_session_id === agentsOf))
        .sort(newest)
        .map((a) => ({ session: a, children: [] }));
    case "archived":
      return list
        .filter((s) => s.archived)
        .sort(newest)
        .map((s) => ({ session: s, children: [] }));
    case "working": {
      const nodes: SessionNode[] = [];
      for (const m of mains.filter(live).sort(newest)) {
        const children = childrenOf(list, m, (s) => live(s) && isWorking(s));
        if (isWorking(m) || children.length > 0) nodes.push({ session: m, children });
      }
      return nodes;
    }
  }
}

/** The dim number after each filter: how many rows it lists (sessions of any kind for Working and Archived). */
export function filterCounts(list: readonly ProjectSession[]): Record<SessionFilter, number> {
  const live = list.filter((s) => !s.archived);
  return {
    all: live.filter((s) => s.kind === "main").length,
    working: live.filter(isWorking).length,
    mine: live.filter((s) => s.kind === "main").length,
    agents: live.filter((s) => s.kind === "agent").length,
    archived: list.length - live.length,
  };
}

/** The glyph of a session's state: the ring family of decision 29. A stopped session rests like an idle one. */
export function glyphOf(state: ProjectSessionState): GlyphState {
  return state === "working" ? "working" : state === "waiting" ? "needs" : state === "failed" ? "failed" : "idle";
}

const STATE_WORD: Record<ProjectSessionState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
};
export const stateWord = (state: ProjectSessionState): string => STATE_WORD[state];

/** The state in words for a session: "No requests yet" for an empty one (it is idle, not working), else the state's word. */
export const sessionStateWord = (s: Pick<ProjectSession, "kind" | "state" | "exchanges">): string =>
  hasNoRequests(s) ? "No requests yet" : stateWord(s.state);

const exchangesOf = (s: ProjectSession): string => (s.exchanges > 0 ? exchangeCount(s.exchanges) : isWorking(s) ? "First request running" : "No requests yet");

/** What a row says: state glyph, title, "Nov 12 · 5 exchanges · Opus 5.5" and, at the right, "current" or the last activity. */
export type SessionRowModel = { id: string; glyph: GlyphState; state: string; title: string; description: string; tail: string; current: boolean };

export function sessionRow(s: ProjectSession, now: number, modelName: (value: string) => string): SessionRowModel {
  const parts = [formatDay(s.started_at, now)];
  if (s.kind === "main") parts.push(exchangesOf(s));
  if (s.model !== "") parts.push(modelName(s.model));
  return {
    id: s.id,
    glyph: glyphOf(s.state),
    state: sessionStateWord(s),
    title: s.title.trim() === "" ? (s.kind === "main" ? "New session" : "Agent session") : s.title,
    description: parts.join(" · "),
    tail: s.current ? "current" : formatWhen(s.last_activity_at, now),
    current: s.current,
  };
}

/** The line under a session's title in its detail: the day, size, model and, for a main session, how many agents it started. */
export function detailLine(s: ProjectSession, now: number, modelName: (value: string) => string): string {
  const parts = [formatDay(s.started_at, now)];
  if (s.kind === "main") parts.push(exchangesOf(s));
  if (s.kind === "main" && s.children > 0) parts.push(`${s.children} ${s.children === 1 ? "agent" : "agents"}`);
  if (s.model !== "") parts.push(modelName(s.model));
  if (s.archived) parts.push("archived");
  return parts.join(" · ");
}

/** The main session an agent session belongs to, when it is in the list. */
export function parentOf(list: readonly ProjectSession[], s: ProjectSession): ProjectSession | undefined {
  return s.parent_session_id === undefined ? undefined : list.find((x) => x.id === s.parent_session_id);
}

/** The five most recent main sessions (not archived) for the sidebar, and whether more exist. */
export const SIDEBAR_SESSIONS = 5;
export function sidebarSessions(list: readonly ProjectSession[]): { shown: ProjectSession[]; more: boolean } {
  const mains = list.filter((s) => s.kind === "main" && !s.archived).sort(newest);
  return { shown: mains.slice(0, SIDEBAR_SESSIONS), more: mains.length > SIDEBAR_SESSIONS };
}

/** A project "has more than one session" (and gets an expander in the sidebar) when two main sessions exist. */
export const hasSeveral = (list: readonly ProjectSession[]): boolean => list.filter((s) => s.kind === "main" && !s.archived).length > 1;

const BLOCKED: Record<string, string> = {
  not_current: "Resume this session to continue it.",
  steer_unsupported: "This agent can't take a message while it works. Continue it when it finishes.",
  not_running: "This agent has finished and can't be continued.",
  not_continuable: "This agent can't be continued: its conversation was not kept.",
  builtin_loop_unavailable: "The built-in agent loop is not available, so this agent can't be continued.",
};

/**
 * The text under a disabled composer: the harness's own sentence when it sent one, else the reason by code. A session that
 * can be messaged has none.
 */
export function blockedText(s: Pick<ProjectSession, "can_message" | "message_blocked">): string | null {
  if (s.can_message) return null;
  const b = s.message_blocked;
  if (!b) return "This session can't take a message now.";
  const text = b.message.trim();
  return text !== "" ? (/[.!?]$/.test(text) ? text : `${text}.`) : (BLOCKED[b.code] ?? "This session can't take a message now.");
}

/** Plain words for the 409s of the sessions routes (`apps/harness/docs/sessions.md`); any other code keeps the harness's message. */
const ERRORS: Record<string, string> = {
  turn_in_progress: "Wait for the current request to finish, or stop it.",
  current_session: "This is the current session. Resume another one first.",
  session_running: "This session is still working. Stop it first.",
  not_continuable: "This agent can't be continued: its conversation was not kept. Ask the orchestrator to start a new one.",
  steer_unsupported: "This agent can't take a message while it works. Wait until it finishes, then continue it.",
  not_running: "This session is not working, so there is nothing to stop.",
  not_main_session: "Only a conversation with the orchestrator can be resumed.",
  not_agent_session: "Messages to the orchestrator go through the project's conversation.",
  builtin_loop_unavailable: "The built-in agent loop is not available, so this agent can't be continued.",
  not_found: "This session no longer exists. It may have been deleted.",
};
export function sessionErrorText(code: string, message: string): string {
  const text = message.trim();
  return ERRORS[code] ?? (text === "" ? "That did not work. Try again." : /[.!?]$/.test(text) ? text : `${text}. Try again.`);
}

/** What a message to an agent session did, as one quiet line. */
export function outcomeText(outcome: "steered" | "continued"): string {
  return outcome === "steered" ? "Steered: the agent reads it at its next step." : "Continued: the agent is working on it again.";
}

const AGENT_STATUS: Record<ProjectSessionState, Agent["status"]> = {
  working: "running",
  waiting: "running",
  idle: "completed",
  failed: "failed",
  stopped: "cancelled",
};

/**
 * An agent row for a transcript whose agent the project state does not hold (a session of an agent that is no longer in the
 * list, read through `getSessionTranscript`). Only what the conversation components show is filled in.
 */
export function placeholderAgent(s: ProjectSession, projectId: string, task = ""): Agent {
  return {
    id: s.agent_id ?? s.id,
    project_id: projectId,
    parent_id: s.kind === "main" ? null : (s.parent_session_id ?? "parent"),
    depth: s.kind === "main" ? 0 : 1,
    role: s.kind === "main" ? "orchestrator" : "agent",
    title: s.title,
    task,
    model: s.model,
    tier: null,
    status: AGENT_STATUS[s.state],
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: s.started_at,
    started_at: s.started_at,
    finished_at: s.state === "working" || s.state === "waiting" ? null : s.last_activity_at,
  };
}

/** A detail pane narrower than this cannot hold the conversation at its own scale (the chat's floor): the transcript goes compact. */
export const COMPACT_BELOW = 420;
export const isCompact = (width: number): boolean => width > 0 && width < COMPACT_BELOW;

/**
 * The title after "New session · earlier:" at the top of a main session: the harness's own boundary marker when it sent one
 * (`conversations[]` of the session's transcript), else the main session started just before this one. null for the first one.
 */
export function earlierSession(list: readonly ProjectSession[], s: ProjectSession, markerTitle?: string): { id: string | null; title: string } | null {
  const before = list.filter((x) => x.kind === "main" && x.id !== s.id && startedMs(x) < startedMs(s)).sort(newest)[0];
  const title = markerTitle?.trim() || before?.title.trim() || "";
  if (!before && title === "") return null;
  return { id: before?.id ?? null, title: title === "" ? "an earlier session" : title };
}

/** One open row at a time: choosing the open one closes it, choosing another replaces it. */
export function toggleOpen(current: string | null, id: string): string | null {
  return current === id ? null : id;
}
