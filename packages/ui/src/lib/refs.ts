import type { Ref, RefCallback } from "react";

/** Writes `el` into a ref given as an object or a callback (for primitives that keep their own ref and forward the caller's). */
export function assignRef<T>(ref: Ref<T> | undefined, el: T | null): void {
  if (typeof ref === "function") ref(el);
  else if (ref) ref.current = el;
}

export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (el) => {
    for (const ref of refs) assignRef(ref, el);
  };
}
