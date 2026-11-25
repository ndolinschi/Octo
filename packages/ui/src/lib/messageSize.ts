/**
 * P2-6: the message's size against the harness's body limit. Its own chunk: the composer loads it once a text could be near
 * the limit (`mayNearLimit`), so the entry bundle carries only that length check.
 */
import { MESSAGE_COUNTER_FROM, MESSAGE_ENVELOPE_BYTES, MESSAGE_MAX_BYTES, mayNearLimit } from "./composerInput";

/** UTF-8 bytes of `JSON.stringify(text)`, without building it. */
export function jsonByteLength(text: string): number {
  let n = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 6; // a lone surrogate is escaped as \uXXXX
    } else n += 3;
  }
  return n;
}

export type MessageSize = { bytes: number; limit: number; over: boolean; near: boolean; label: string };

/**
 * The message's size against the limit; null while it is surely far below (`mayNearLimit`: a short text is never counted,
 * so typing stays free of whole-text work until the text is large). `label` is the quiet counter's text.
 */
export function messageSize(text: string): MessageSize | null {
  if (!mayNearLimit(text)) return null;
  const room = MESSAGE_MAX_BYTES - MESSAGE_ENVELOPE_BYTES;
  const bytes = jsonByteLength(text);
  return {
    bytes,
    limit: room,
    over: bytes > room,
    near: bytes >= room * MESSAGE_COUNTER_FROM,
    label: `${formatBytes(bytes)} of ${formatBytes(MESSAGE_MAX_BYTES)}`,
  };
}

/** "2.4 MB", "812 KB" (binary units, as the limit: 1 MB = 1 MiB). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The refusal shown instead of sending a message over the limit. An attached file travels inside the message too
 * (`withAttachments`), so the way out is a file in the project the agent reads: the advice the attachment refusal gives.
 */
export function tooLongText(bytes: number): string {
  return `This message is too long to send (${formatBytes(bytes)}; the limit is ${formatBytes(MESSAGE_MAX_BYTES)}). Save it as a file in the project and mention it with @ instead.`;
}
