import { hasParallelSessions, sessionBridge, type MemoryExchange } from "@octo/agent-client";
import { useEffect, useRef, useState } from "react";
import { SWITCH_HOLD_MS } from "../lib/constants";
import { useLatest } from "../lib/hooks";
import { loadPref, PREFS } from "../lib/storage";
import type { storedEndingLookup } from "../lib/storedEndings";
import { useApp } from "./app";
import { ProjectProvider, useProject } from "./project";
import { lastSessionCodec } from "./projectCache";
import { openingConversation } from "./projectOpening";
import { loadTurnChanges } from "./turnChanges";
import { walkFolders } from "./fileWalk";

/** The route switched to (its project is never null here). */
type Target = { projectId: string | null; agentId: string | null; sessionId: string | null };

/** The longest a switch waits for the project's file walk. */
const WALK_WAIT_MS = 1000;

type OwnRead = { exchanges: MemoryExchange[]; lookup: typeof storedEndingLookup } | null;

/**
 * Decision 98: a project switched to that this window has not read yet is read here, out of sight, while the screen keeps
 * what it showed: the project, its sessions, what waits, the conversation the route opens, its queue, how its requests
 * ended and the files its turns changed. What is read stays in the project's snapshot (`projectCache`), so the workspace
 * mounted next paints it complete in one frame.
 * `onShow` once it is all in (or the project could not be read: its error screen is what to show then). A read slower than
 * SWITCH_HOLD_MS calls `onLate` (the shell shows the loading state) and then `onShow` no sooner than SWITCH_HOLD_MS later, so
 * the loading state never flashes. Its own chunk (the shell warms it after the first paint).
 */
export default function ProjectPreload(props: { target: Target; onLate(): void; onShow(): void }) {
  const [ready, setReady] = useState(false);
  const [lateAt, setLateAt] = useState<number | null>(null);
  const calls = useLatest(props);
  useEffect(() => {
    const id = ready
      ? window.setTimeout(() => calls.current.onShow(), lateAt === null ? 0 : lateAt + SWITCH_HOLD_MS - performance.now())
      : lateAt === null
        ? window.setTimeout(() => {
            setLateAt(performance.now());
            calls.current.onLate();
          }, SWITCH_HOLD_MS)
        : undefined;
    return () => window.clearTimeout(id);
  }, [ready, lateAt, calls]);
  return (
    <ProjectProvider projectId={props.target.projectId ?? ""}>
      <Ready target={props.target} onReady={() => setReady(true)} />
    </ProjectProvider>
  );
}

function Ready({ target, onReady }: { target: Target; onReady(): void }) {
  const { bridge } = useApp();
  const { projectId, project, state, synced, loadError, loadFailures, ensureMessages, kept } = useProject();
  // Known with the project (its sessions arrive in the same update): everything below is read at once, side by side.
  const opening = project ? openingConversation(state, project, target, loadPref(PREFS.lastSession(projectId), lastSessionCodec)) : null;
  const agentId = opening?.agentId ?? "";
  const sessionId = opening?.sessionId ?? "";
  useEffect(() => {
    if (agentId) ensureMessages(agentId);
  }, [agentId, ensureMessages]);
  const messages = agentId ? state.messages[agentId] : undefined;
  const agent = agentId ? state.agents[agentId] : undefined;
  const loaded = messages !== undefined || (agentId !== "" && loadFailures[agentId] !== undefined);
  // The conversation's own reads, under the keys `QueueSlot` and the transcript's stored endings use.
  const parallel = hasParallelSessions(state);
  const endingsOf = (parallel ? sessionId : state.sessions.currentId) ?? "";
  const getSession = bridge.getSession;
  const endings = agent?.parent_id === null && agent.status !== "running" && getSession ? endingsOf : "";
  // Started as soon as the session is known (beside the messages, not after them); the other sessions' endings, which only
  // the messages name, follow once those are in.
  const own = useRef<{ key: string; read: Promise<OwnRead> } | null>(null);
  const ownKey = agentId ? `${sessionId} ${endings}` : "";
  const folders = project?.folders.map((f) => f.label).join("\n") ?? "";
  useEffect(() => {
    if (!ownKey) return;
    const scoped = parallel && sessionId ? sessionBridge(bridge, sessionId) : bridge;
    const queueKey = parallel ? sessionId : "";
    const queue = scoped.getQueue?.(projectId).then(
      (q) => void kept.queues.set(queueKey, q),
      // Not read: the composer's queue reads it again once shown.
      () => undefined,
    );
    const first: Promise<OwnRead> =
      endings && getSession
        ? Promise.all([getSession(projectId, endings), import("../lib/storedEndings")]).then(
            ([detail, m]) => ({ exchanges: detail.exchanges, lookup: m.storedEndingLookup }),
            // Not read: the transcript reads its endings again once shown.
            () => null,
          )
        : Promise.resolve(null);
    // The turns' "N files changed" lines, shared by the project's turns.
    const changes = loadTurnChanges(bridge, projectId);
    // The files, for file links in its prose (`FileLink`): walked once per project and waited for at most WALK_WAIT_MS (a large
    // tree may take longer: its links then appear as the walk ends); a project shown again walks again itself.
    const walked =
      kept.files.size > 0
        ? null
        : Promise.race([
            walkFolders(folders ? folders.split("\n") : [], async (folder, path) => {
              const entries = await bridge.listFiles(projectId, folder, path).catch(() => null);
              const paths = (entries ?? []).flatMap((e) => (e.type === "file" ? [e.path] : []));
              kept.files.set(folder, [...(kept.files.get(folder) ?? []), ...paths]);
              return entries;
            }),
            new Promise((done) => window.setTimeout(done, WALK_WAIT_MS)),
          ]);
    own.current = { key: ownKey, read: Promise.all([queue, first, changes, walked]).then(([, r]) => r) };
  }, [ownKey, parallel, sessionId, bridge, projectId, kept, endings, getSession, folders]);
  const messageSessions = [...new Set((messages ?? []).flatMap((m) => (m.session_id ? [m.session_id] : [])))].sort().join(" ");
  const [read, setRead] = useState(false);
  useEffect(() => {
    const mine = own.current;
    if (!loaded || mine?.key !== ownKey) return;
    let alive = true;
    const others = messageSessions.split(" ").filter((id) => id && id !== endings);
    const rest =
      getSession && endings
        ? Promise.all(
            others.map((id) =>
              getSession(projectId, id).then(
                (d) => d.exchanges,
                () => [],
              ),
            ),
          )
        : Promise.resolve([]);
    void Promise.all([mine.read, rest]).then(([first, more]) => {
      if (first) kept.endings.set(endings, first.lookup(first.exchanges, ...more));
      if (alive) setRead(true);
    });
    return () => {
      alive = false;
    };
  }, [loaded, ownKey, messageSessions, endings, getSession, projectId, kept]);
  const ready = (loadError !== null && project === null) || (synced > 0 && loaded && read);
  const done = useLatest(onReady);
  useEffect(() => {
    if (ready) done.current();
  }, [ready, done]);
  return null;
}
