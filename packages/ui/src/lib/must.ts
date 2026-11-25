/** Test support: narrows away `undefined`/`null`, failing loudly instead of a silent `!`. Not imported by app code. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}
