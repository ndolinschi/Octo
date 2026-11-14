import { slot, type TabMemory } from "../../state/workspace/tabMemory";
import type { TabId } from "../../state/workspace/layout";
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

/** Puts `text` into the conversation's composer (an unsent draft: the person reads it and sends it); round 3: words, B7. */
export function prefillComposer(memory: TabMemory, tab: TabId, text: string): void {
  const member = draftOf(memory, tab).join(() => undefined);
  member.save(text);
  member.leave();
}
