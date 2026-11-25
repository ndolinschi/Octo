/** 7h: ←/→ (and ↑/↓, Home, End) between the chips of a one-line group that is one Tab stop; null for any other key. */
export function chipKeyTarget(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  const to: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: count - 1 };
  const next = to[key];
  return next === undefined ? null : Math.max(0, Math.min(count - 1, next));
}
