export type PendingReveal = { tick: number; key: string };

/**
 * Coordinates one-shot `scrollIntoView` reveals for `FileTree`.
 * Only explicit selection/reveal changes arm a scroll; expanding or collapsing unrelated subfolders never jumps back to `selectedKey`.
 */
export class TreeScrollController {
  private lastTick = -1;
  private lastKey: string | null = null;
  private pending: PendingReveal | null = null;

  sync(revealTick: number, selectedKey: string | null): void {
    if (this.lastTick === revealTick && this.lastKey === selectedKey) return;
    this.lastTick = revealTick;
    this.lastKey = selectedKey;
    this.pending = selectedKey ? { tick: revealTick, key: selectedKey } : null;
  }

  cancel(): void {
    this.pending = null;
  }

  consume(revealTick: number, selectedKey: string | null, hasElement: (key: string) => boolean): string | null {
    const req = this.pending;
    if (!req || req.tick !== revealTick || req.key !== selectedKey) return null;
    if (!hasElement(req.key)) return null;
    this.pending = null;
    return req.key;
  }
}
