import { useEffect } from "react";
import type { ProjectState } from "@octo/agent-client";
import { closeLayer, openLayer } from "../../../lib/historyLayer";
import { useLatest } from "../../../lib/hooks";
import { parseTab, type TabId, type TabRef } from "../../../state/workspace/layout";

/** A conversation tab: Chat, or a main session's own tab (decision 96). Everything else is a panel on the phone. */
export function isConversation(tab: TabId, state: ProjectState): boolean {
  const ref = parseTab(tab);
  if (ref?.kind === "chat") return true;
  return ref?.kind === "session" && state.sessions.list.find((s) => s.id === ref.sessionId)?.kind === "main";
}

/** The main session a conversation tab shows, or null. */
export function conversationSession(tab: TabId, chatSessionId: string | null, state: ProjectState): string | null {
  const ref = parseTab(tab);
  if (ref?.kind === "chat") return chatSessionId ?? state.sessions.defaultId ?? null;
  return ref?.kind === "session" ? ref.sessionId : null;
}

/**
 * How Back shows a panel again: the tab itself when it is still open; else the tab is reopened the way it was opened (a file's
 * row replaces the Files tab with the file on the phone, so Back from the file opens Files again, not the conversation).
 */
export type Reopen = { kind: "activate"; tab: TabId } | { kind: "chat" } | Exclude<TabRef, { kind: "chat" }>;

export function reopenFor(tab: TabId, open: readonly TabId[]): Reopen {
  if (open.includes(tab)) return { kind: "activate", tab };
  const ref = parseTab(tab);
  return ref === null || ref.kind === "chat" ? { kind: "chat" } : ref;
}

type Memory = { project: string; last: TabId | null; layers: { token: string; tab: TabId }[]; expect: TabId | null };

/** One record for the app (the phone header can remount with the group that has focus). */
let mem: Memory = { project: "", last: null, layers: [], expect: null };

/**
 * Direction 7: each panel the phone opens over the conversation (a tool, a file, a run, a helper's transcript) is a history
 * entry, so Back returns to what was shown before it: a file to the Files tree, the tree to the conversation. Going back to a
 * conversation by any other way drops the panels' entries; a panel shown again drops the entries above it.
 */
export function usePanelHistory(projectId: string, active: TabId, conversation: boolean, back: (tab: TabId) => void): void {
  const go = useLatest(back);
  useEffect(() => {
    if (mem.project !== projectId) {
      for (const l of mem.layers.slice(0, 1)) closeLayer(l.token);
      mem = { project: projectId, last: active, layers: [], expect: null };
      return;
    }
    const prev = mem.last;
    mem.last = active;
    if (prev === null || prev === active) return;
    const ours = mem.expect === active;
    mem.expect = null;
    if (ours) return;
    if (conversation) {
      const first = mem.layers[0];
      mem.layers = [];
      if (first) closeLayer(first.token);
      return;
    }
    const at = mem.layers.findIndex((l) => l.tab === active);
    if (at >= 0) {
      const above = mem.layers[at + 1];
      mem.layers = mem.layers.slice(0, at + 1);
      if (above) closeLayer(above.token);
      return;
    }
    const token = openLayer((navigated) => {
      const i = mem.layers.findIndex((l) => l.token === token);
      if (i < 0) return;
      mem.layers = mem.layers.slice(0, i);
      // A row in the panel that opened a route (an agent in Agents): the route shows what it should; showing `prev` again
      // here would navigate once more and take the place of that route in the history.
      if (navigated) return;
      mem.expect = prev;
      go.current(prev);
    });
    mem.layers.push({ token, tab: active });
  }, [projectId, active, conversation, go]);
}
