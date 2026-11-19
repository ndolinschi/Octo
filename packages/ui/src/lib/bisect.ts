/** The first index in `0..n` for which `pred` holds, when `pred` is false and then true along the range (`n` when it never holds). */
export function firstTrue(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
