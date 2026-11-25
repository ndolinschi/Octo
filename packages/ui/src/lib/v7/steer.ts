/**
 * Parity B6: which user messages landed mid-turn: `message.steered` names the text; the stored message arrives as an ordinary
 * user message, so a prompt is marked when its text was steered and it has not been matched yet.
 */
export function markSteered(steered: readonly string[], texts: readonly string[]): ReadonlySet<number> {
  const left = [...steered];
  const out = new Set<number>();
  texts.forEach((text, i) => {
    const at = left.indexOf(text);
    if (at >= 0) {
      left.splice(at, 1);
      out.add(i);
    }
  });
  return out;
}
