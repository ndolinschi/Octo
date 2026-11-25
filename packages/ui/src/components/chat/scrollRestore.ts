/** How long a restore waits for the transcript to grow tall enough (it is lazy: Markdown, turns mounting as they come near). */
const RESTORE_WAIT_MS = 5000;

/**
 * Scrolls `el` to `top` once the content is tall enough to reach it. Setting it earlier clamps to the end of a still-short
 * transcript, which reads as the reader being at the bottom and makes the view follow the stream down. Gives up after
 * `RESTORE_WAIT_MS` or when the reader scrolls themselves. Returns the cancel function.
 */
export function restoreScrollWhenReachable(el: HTMLElement, top: number, applied: () => void): () => void {
  let done = false;
  const stop = () => {
    done = true;
    ro?.disconnect();
    window.clearTimeout(giveUp);
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(name, stop);
  };
  const attempt = () => {
    if (done) return;
    if (el.clientHeight > 0 && el.scrollHeight - el.clientHeight >= top) {
      applied();
      el.scrollTop = top;
      stop();
    }
  };
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(attempt);
  ro?.observe(el);
  if (el.firstElementChild) ro?.observe(el.firstElementChild);
  const giveUp = window.setTimeout(stop, RESTORE_WAIT_MS);
  for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(name, stop, { passive: true });
  attempt();
  return stop;
}
