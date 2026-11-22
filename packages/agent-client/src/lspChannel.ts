import type { LanguageServerExit } from "./types";

export const MAX_CHANNEL_QUEUE = 1024;

export type LspChannel = {
  push(message: unknown): void;
  exit(info: LanguageServerExit): void;
  close(): void;
  onMessage(cb: (message: unknown) => void): () => void;
  onExit(cb: (info: LanguageServerExit) => void): () => void;
};

export function isExitInfo(v: unknown): v is LanguageServerExit {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.code === "number" && Number.isFinite(r.code) && (r.reason === undefined || typeof r.reason === "string");
}

/** Fans server messages out to listeners; holds them until the first listener attaches. */
export function createLspChannel(): LspChannel {
  const messageListeners = new Set<(message: unknown) => void>();
  const exitListeners = new Set<(info: LanguageServerExit) => void>();
  let queue: unknown[] = [];
  let buffering = true;
  let exited: LanguageServerExit | undefined;

  return {
    push(message) {
      if (exited) return;
      if (buffering) {
        queue.push(message);
        if (queue.length > MAX_CHANNEL_QUEUE) queue.shift();
      } else {
        messageListeners.forEach((cb) => cb(message));
      }
    },
    exit(info) {
      if (exited) return;
      exited = info;
      buffering = false;
      queue = [];
      exitListeners.forEach((cb) => cb(info));
    },
    close() {
      buffering = false;
      queue = [];
    },
    onMessage(cb) {
      messageListeners.add(cb);
      if (buffering) {
        buffering = false;
        const pending = queue;
        queue = [];
        pending.forEach(cb);
      }
      return () => void messageListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      if (exited) cb(exited);
      return () => void exitListeners.delete(cb);
    },
  };
}
