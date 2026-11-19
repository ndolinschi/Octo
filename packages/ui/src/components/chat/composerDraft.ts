import { slot, type TabMemory } from "../../state/workspace/tabMemory";
import type { TabId } from "../../state/workspace/layout";
import { appendMention } from "../../lib/chatMention";
import { DraftBus } from "./draftBus";

/* The composers' shared drafts, apart from `useOrchestratorComposer` so the agent header and the delegation cards can fill
 * one without importing the composer hook (an import cycle through `Composer`). */

const DRAFT = slot("draft", (v): v is DraftBus => v instanceof DraftBus);

/** One bus per tab key, created on first use and kept in the tab memory (so it survives the tab remounting). */
export function draftOf(memory: TabMemory, tab: TabId): DraftBus {
  const existing = memory.get(tab, DRAFT);
  if (existing) return existing;
  const bus = new DraftBus();
  memory.set(tab, DRAFT, bus);
  return bus;
}

function writeDraft(bus: DraftBus, text: string): void {
  const member = bus.join(() => undefined);
  member.save(text);
  member.leave();
}

/** Puts `text` into the conversation's composer (an unsent draft: the person reads it and sends it); round 3: words, B7. */
export function prefillComposer(memory: TabMemory, tab: TabId, text: string): void {
  writeDraft(draftOf(memory, tab), text);
}

/** G4: "Add to chat" puts a file mention at the end of the draft (`lib/chatMention`), every composer on `bus` hears it. */
export function appendToDraft(bus: DraftBus, mention: string): void {
  writeDraft(bus, appendMention(bus.value, mention));
}

/** Clears `bus` directly without retaining a listener (used when carrying a draft away to another project). */
export function clearDraft(bus: DraftBus): void {
  writeDraft(bus, "");
}

type PendingCrossProjectDraft = { projectId: string; sessionId: string | null; text: string };
let pendingCrossProjectDraft: PendingCrossProjectDraft | null = null;

/** Carries unsent composer text across a project switch initiated from the empty-session project selector. */
export function stashCrossProjectDraft(projectId: string, sessionId: string | null, text: string): void {
  pendingCrossProjectDraft = text ? { projectId, sessionId, text } : null;
}

/** Consumes any stashed draft intended for `(projectId, sessionId)` once mounted in the target workspace. */
export function takeCrossProjectDraft(projectId: string, sessionId: string | null): string | null {
  if (!pendingCrossProjectDraft || pendingCrossProjectDraft.projectId !== projectId) return null;
  if (pendingCrossProjectDraft.sessionId !== null && sessionId !== null && pendingCrossProjectDraft.sessionId !== sessionId) return null;
  const text = pendingCrossProjectDraft.text;
  pendingCrossProjectDraft = null;
  return text;
}

/** Transfers any matching cross-project draft into an empty target `bus`. */
export function applyCrossProjectDraft(bus: DraftBus | undefined, projectId: string, sessionId: string | null): void {
  if (!bus || bus.value) return;
  const text = takeCrossProjectDraft(projectId, sessionId);
  if (text !== null) writeDraft(bus, text);
}
