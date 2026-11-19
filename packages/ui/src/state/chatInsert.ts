/**
 * G4 (2026-11-18): "Add to chat" from the editor and the file tree puts a file mention into the conversation's composer
 * without the files feature importing the chat (features may not import each other). The chat registers how to insert;
 * the last composer mounted wins and leaving unregisters it. This module owns the channel; nothing else holds it.
 */
type Inserter = (text: string) => void;

const inserters: Inserter[] = [];

/** The chat's composer calls this while it is mounted; the returned function unregisters it. */
export function registerChatInsert(insert: Inserter): () => void {
  inserters.push(insert);
  return () => {
    const i = inserters.lastIndexOf(insert);
    if (i >= 0) inserters.splice(i, 1);
  };
}

/** Whether a composer can take text now (the menus offer "Add to chat" only then). */
export function canAddToChat(): boolean {
  return inserters.length > 0;
}

/** Appends `text` to the conversation's draft and shows the conversation with the caret in its composer. */
export function addToChat(text: string): boolean {
  const insert = inserters[inserters.length - 1];
  if (!insert) return false;
  insert(text);
  return true;
}
