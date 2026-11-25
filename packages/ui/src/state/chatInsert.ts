/**
 * G4 (2026-11-18): "Add to chat" from the editor and the file tree puts a file mention into the conversation's composer
 * without the files feature importing the chat (features may not import each other). The chat registers how to insert;
 * the last composer mounted wins and leaving unregisters it. This module owns the channel; nothing else holds it.
 */
type Handler = (text: string) => void;

function channel() {
  const stack: Handler[] = [];
  return {
    register(fn: Handler): () => void {
      stack.push(fn);
      return () => {
        const i = stack.lastIndexOf(fn);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    ready: () => stack.length > 0,
    send(text: string): boolean {
      const fn = stack[stack.length - 1];
      if (!fn) return false;
      fn(text);
      return true;
    },
  };
}

const insertCh = channel();
const submitCh = channel();

/** The chat's composer calls this while it is mounted; the returned function unregisters it. */
export const registerChatInsert = insertCh.register;
/** Whether a composer can take text now (the menus offer "Add to chat" only then). */
export const canAddToChat = insertCh.ready;
/** Appends `text` to the conversation's draft and shows the conversation with the caret in its composer. */
export const addToChat = insertCh.send;

/** Registers the active conversation's direct submit handler (used by the editor's Mod+I inline edit bar). */
export const registerChatSubmit = submitCh.register;
/** Whether an editor inline-edit bar can send a targeted edit prompt directly to the conversation. */
export const canSubmitToChat = submitCh.ready;
/** Sends (or queues when busy) `text` directly to the active conversation and focuses the chat. */
export const submitToChat = submitCh.send;
