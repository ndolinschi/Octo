import type { Agent, Message, ProjectSession } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../../lib/format";
import { placeholderAgent } from "../../lib/sessions/model";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

export type SessionConversation =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** `boundary`: the title of the session the harness's `/clear` marker says this one followed (a main session only). */
  | { status: "ok"; agent: Agent; messages: Message[]; boundary?: string };

type Read = { key: string; messages: Message[]; boundary?: string } | { key: string; error: string };

/**
 * The conversation of one session for the shared transcript: the live state of the project for what it holds (the current
 * main session, an agent the project lists), else the session's own transcript read from the harness. A read repeats when
 * the session's activity or state moves on (`session.updated`), and keeps showing the old text meanwhile.
 */
export function useSessionConversation(session: ProjectSession): SessionConversation {
  const { bridge } = useApp();
  const { projectId, project, state, ensureMessages } = useProject();
  const orchestrator = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const live: Agent | undefined = session.kind === "agent" ? (session.agent_id ? state.agents[session.agent_id] : undefined) : orchestrator;
  // A main session that is not current is history: it never streams, whatever the orchestrator is doing for the current one.
  const agent = useMemo<Agent>(() => {
    if (session.kind === "main") return { ...(live ?? placeholderAgent(session, projectId)), status: session.current ? (live?.status ?? "idle") : "idle" };
    return live ?? placeholderAgent(session, projectId);
  }, [session, live, projectId]);
  const liveMessages = live ? state.messages[live.id] : undefined;
  const liveList = live !== undefined && (session.kind === "agent" || session.current) ? liveMessages : undefined;
  const useLive = liveList !== undefined;
  const agentId = live?.id;
  useEffect(() => {
    if (session.kind === "agent" && agentId) ensureMessages(agentId);
  }, [session.kind, agentId, ensureMessages]);

  const stamp = [session.id, session.last_activity_at, session.state, session.exchanges].join("|");
  const mine = session.id + "|";
  const [read, setRead] = useState<Read | null>(null);
  const read2 = bridge.getSessionTranscript;
  useEffect(() => {
    // A live main session still reads its own transcript once, for the marker of the `/clear` that started it.
    if (!read2 || (useLive && session.kind !== "main")) return;
    let cancelled = false;
    read2.call(bridge, projectId, session.id).then(
      (t) => {
        const boundary = t.conversations?.[0]?.title;
        if (!cancelled) setRead({ key: stamp, messages: t.messages, ...(boundary ? { boundary } : {}) });
      },
      (e: unknown) => {
        if (cancelled || useLive) return;
        setRead((prev) => (prev && "messages" in prev && prev.key.startsWith(mine) ? prev : { key: stamp, error: errorMessage(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [useLive, read2, bridge, projectId, session.id, session.kind, stamp, mine]);

  if (liveList) {
    // A current main session's messages are the whole conversation once (earlier sessions above a `/clear`); keep this one's.
    const messages = session.kind === "main" ? liveList.filter((m) => m.session_id === undefined || m.session_id === session.id) : liveList;
    const boundary = read && "messages" in read && read.key.startsWith(mine) ? read.boundary : undefined;
    return { status: "ok", agent, messages, ...(boundary ? { boundary } : {}) };
  }
  if (!read2) return { status: "error", message: "This harness cannot read a session's transcript. Update the harness." };
  if (!read?.key.startsWith(mine)) return { status: "loading" };
  if ("error" in read) return { status: "error", message: read.error };
  return { status: "ok", agent, messages: read.messages, ...(read.boundary ? { boundary: read.boundary } : {}) };
}
