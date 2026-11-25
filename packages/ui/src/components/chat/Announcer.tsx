import { useCallback, useEffect, useRef } from "react";
import type { Agent } from "@octo/agent-client";
import { askAnnouncement, endAnnouncement, newIds } from "../../lib/announce";
import { agentDuration } from "../../lib/duration";
import { useLatest } from "../../lib/hooks";
import { useProject } from "../../state/project";

/**
 * 7b: the conversation's one polite live region. It says when the agent starts ("Atlas API is working"), how a request ended
 * ("Finished: Worked for 8s", "Failed after 8s", "Stopped after 8s") and when an approval or a form appears ("Atlas API asks:
 * Run npm test"). The reply's text is never streamed into it. Only changes after the view mounted are said. The words are
 * written into the region's node (an outside system for React: the screen reader), not kept as state.
 */
export function Announcer({ agent, name, project, orchestrator }: { agent: Agent; name: string; project: string; orchestrator: boolean }) {
  const { state } = useProject();
  const region = useRef<HTMLParagraphElement>(null);
  // The same words twice in a row still change the region (a no-break space), so they are read again.
  const say = useCallback((next: string) => {
    const el = region.current;
    if (el) el.textContent = el.textContent === next ? `${next} ` : next;
  }, []);
  const agentNow = useLatest(agent);

  const running = agent.status === "running";
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current) say(`${name} is working`);
    wasRunning.current = running;
  }, [running, name, say]);

  // The orchestrator's request endings come as `lastTurn` (a new object per ending); an agent's own conversation ends with its status.
  const lastTurn = orchestrator ? state.lastTurn : null;
  const firstTurn = useRef(lastTurn);
  useEffect(() => {
    if (!lastTurn || lastTurn === firstTurn.current) return;
    firstTurn.current = lastTurn;
    say(endAnnouncement(lastTurn.status, agentDuration(agentNow.current, Date.now())));
  }, [lastTurn, say, agentNow]);
  const status = orchestrator ? null : agent.status;
  const firstStatus = useRef(status);
  useEffect(() => {
    if (status === firstStatus.current) return;
    firstStatus.current = status;
    if (status === "completed" || status === "failed" || status === "cancelled") say(endAnnouncement(status, agentDuration(agentNow.current, Date.now())));
  }, [status, say, agentNow]);

  // New approvals and forms of the project (the orchestrator's view shows them).
  const seen = useRef<Set<string> | null>(null);
  const approvals = orchestrator ? state.approvals : null;
  const inputs = orchestrator ? state.inputs : null;
  useEffect(() => {
    if (!approvals || !inputs) return;
    const waits = [...approvals, ...inputs];
    if (seen.current === null) {
      seen.current = new Set(waits.map((w) => w.id));
      return;
    }
    const fresh = newIds(seen.current, waits);
    for (const id of fresh) seen.current.add(id);
    const last = waits.find((w) => w.id === fresh[fresh.length - 1]);
    if (last) say(askAnnouncement(project, last.title));
  }, [approvals, inputs, project, say]);

  return <p ref={region} aria-live="polite" className="sr-only" />;
}
