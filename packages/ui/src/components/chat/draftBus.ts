/**
 * The unsent text of one composer key, shared by every composer mounted on it (the Chat tab's and the floating one).
 * A composer saves what its user typed; the others hear it. The saver is never told its own text back: an echo is a
 * state update after every keystroke (an effect that sets state on each commit, which React counts as a nested update
 * and aborts with "Maximum update depth exceeded" once typing outruns the render, ~1000 characters in).
 */
export class DraftBus {
  private text: string;
  private readonly members = new Set<(text: string) => void>();

  constructor(initial = "") {
    this.text = initial;
  }

  get value(): string {
    return this.text;
  }

  /** Joins with `onHeard` (called with text typed in another composer); `save` and `leave` belong to this member. */
  join(onHeard: (text: string) => void): { save(text: string): void; leave(): void } {
    this.members.add(onHeard);
    return {
      save: (text) => {
        if (text === this.text) return;
        this.text = text;
        for (const member of this.members) if (member !== onHeard) member(text);
      },
      leave: () => void this.members.delete(onHeard),
    };
  }
}
