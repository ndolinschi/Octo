import type { Agent } from "@octo/agent-client";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { agentWaiting, WAIT_TEXT } from "../../lib/agentWaiting";
import { plainError } from "../../lib/errors/plain";
import { useLatest } from "../../lib/hooks";
import { useProject } from "../../state/project";
import { activityLine, runningToolOf } from "./activity";
import type { ActivityState } from "./ActivityRow";
import { ANNOUNCE_EVERY_MS, RUN_CARD_LINGER_MS, runTitle } from "./runCard";

const HEAD_STATE: Record<Agent["status"], ActivityState> = { running: "running", completed: "done", failed: "failed", cancelled: "stopped", idle: "pending" };

/**
 * The run card's head (decision 101 a): the state its glyph shows (waiting for the person wins over working) and the title —
 * the activity line's words while it runs, the outcome when it ended. The delegation row and the agent tab's header share it.
 */
export function useRunHead(agent: Agent | undefined, opts: { name: string; interrupted?: boolean }): { state: ActivityState; title: string } {
  const { state } = useProject();
  const id = agent?.id ?? "";
  const messages = state.messages[id];
  const runningTool = useMemo(() => (messages ? runningToolOf(messages) : null), [messages]);
  if (!agent) return { state: "pending", title: "Not started" };
  const running = agent.status === "running";
  const wait = running ? agentWaiting(state, id) : null;
  const waitingOn = running
    ? state.agentOrder.flatMap((cid) => {
        const c = state.agents[cid];
        return c?.parent_id === id && c.status === "running" ? [c.role] : [];
      })
    : [];
  const activity = running
    ? activityLine({
        activity: state.activity[id],
        runningTool,
        writing: Boolean(state.streaming[id]),
        thinking: Boolean(state.thinking[id]),
        waitingOn,
        quietMs: 0,
        agentName: opts.name,
      }).label
    : "";
  const title = runTitle({
    status: agent.status,
    waitText: wait ? WAIT_TEXT[wait] : null,
    activity,
    result: agent.result,
    failure: agent.status === "failed" && agent.error ? plainError(agent.error).sentence : null,
    interrupted: opts.interrupted === true,
  });
  return { state: wait ? "needs" : HEAD_STATE[agent.status], title };
}

/**
 * Whether a sub-agent's run card is open (decision 101). The person's choice wins; until they make one the card follows the
 * waiting rule (`auto`: the orchestrator waits on this agent). When the rule lets go (the agent finished) the card stays a
 * moment so the outcome is read, then folds back into its row — unless focus is inside it: then it stays, as if opened by hand.
 */
export function useRunCardOpen(auto: boolean, frame: RefObject<HTMLElement | null>): { open: boolean; toggle(): void } {
  const [user, setUser] = useState<boolean | null>(null);
  const [linger, setLinger] = useState(false);
  const [prevAuto, setPrevAuto] = useState(auto);
  if (auto !== prevAuto) {
    setPrevAuto(auto);
    setLinger(!auto);
  }
  useEffect(() => {
    if (!linger) return;
    const t = window.setTimeout(() => {
      const el = frame.current;
      if (el && document.activeElement && el.contains(document.activeElement)) setUser(true);
      setLinger(false);
    }, RUN_CARD_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [linger, frame]);
  const open = user ?? (auto || linger);
  return { open, toggle: () => setUser(!open) };
}

/**
 * A polite live region for the card's current step that does not chatter: a change is said at once when nothing was said for
 * `ANNOUNCE_EVERY_MS`, else the latest text is said when that time is up (the steps in between are skipped). Only changes after
 * mount are said. The words go into the region's node (the screen reader is outside React), as `Announcer` does.
 */
export function useThrottledAnnouncement(text: string | null): RefObject<HTMLSpanElement | null> {
  const region = useRef<HTMLSpanElement>(null);
  const latest = useLatest(text);
  const first = useRef(text);
  const changed = useRef(false);
  const lastAt = useRef(0);
  const said = useRef<string | null>(text);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (text === null || (!changed.current && text === first.current)) return;
    changed.current = true;
    const say = () => {
      timer.current = null;
      const next = latest.current;
      const el = region.current;
      if (!el || next === null || next === said.current) return;
      said.current = next;
      lastAt.current = Date.now();
      el.textContent = next;
    };
    const wait = ANNOUNCE_EVERY_MS - (Date.now() - lastAt.current);
    if (wait <= 0) say();
    else timer.current ??= window.setTimeout(say, wait);
  }, [text, latest]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return region;
}
