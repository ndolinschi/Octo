/**
 * A failed turn's error and its hint, each said once (owner, live run: the hint appeared inside the error and again on
 * its own line). The harness sends the hint apart; an error that still ends with it loses that ending here.
 */
export function splitHint(error: string | null, hint: string | undefined): { error: string; hint: string | null } {
  const text = (error ?? "").trim();
  const h = hint?.trim() || null;
  if (!h) return { error: text, hint: null };
  const at = text.lastIndexOf(h);
  const tail = at >= 0 ? text.slice(at + h.length).trim() : "x";
  const stripped = at >= 0 && /^[.\s]*$/.test(tail) ? text.slice(0, at).replace(/[\s.:;,—–-]*(hint:?)?[\s.:;,—–-]*$/i, "") : text;
  return { error: stripped, hint: h };
}

/** "Text." for a sentence that may or may not end with a full stop. */
export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * One click on Retry: `busy` is on while the request is sent and off again however it ends (a retried turn that fails
 * at once left the button on "Retrying…"), and a failed send is reported through `onError`.
 */
export async function runRetry(
  send: (text: string) => Promise<unknown>,
  text: string,
  ui: { setBusy(busy: boolean): void; onError(e: unknown): void },
): Promise<void> {
  ui.setBusy(true);
  try {
    await send(text);
  } catch (e) {
    ui.onError(e);
  } finally {
    ui.setBusy(false);
  }
}
