import { lazy, useEffect, useState, type ComponentType } from "react";

/**
 * A lazily loaded component that renders without suspending once its chunk is in. A plain `lazy` suspends on its first render
 * even when the module is already loaded (the promise settles a tick later), and React then holds the revealed content back
 * until 300 ms after the fallback was shown (its fallback throttle): every first open of a lazy surface (palette, model list,
 * Settings, a tool tab) cost ~300 ms even with its chunk warmed, and a turn first laid out without a part and then with it
 * shifted the conversation (stress: the CLS of opening a long chat). Here the factory hands React a thenable that settles at
 * once when the chunk is in, so warming the chunk (`fetch`, see `lib/warm`) makes the first open as fast as the second.
 */
export type ReadyLazy<P extends object> = { Component: ComponentType<P>; fetch(): Promise<unknown>; isReady(): boolean };

/** A settled promise whose `then` calls back at once, so React's `lazy` reads the component in the same render. */
function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value);
  void Object.defineProperty(p, "then", {
    value: (onFulfilled?: ((v: T) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) =>
      onFulfilled ? Promise.resolve(onFulfilled(value)) : Promise.prototype.then.call(p, onFulfilled, onRejected),
  });
  return p;
}

export function readyLazy<P extends object>(load: () => Promise<ComponentType<P>>): ReadyLazy<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  // A failed fetch (a warm-up while offline) is forgotten, so the next fetch or render tries again.
  const fetch = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        loading = null;
        throw e;
      },
    ));
  const Component = lazy(() => (loaded ? settled({ default: loaded }) : fetch().then((c) => ({ default: c }))));
  return { Component, fetch, isReady: () => loaded !== null };
}

/** Whether every part's chunk is in (fetching the missing ones); a failed fetch counts as ready (the part then fails where it renders). */
export function usePartsReady(parts: readonly { fetch(): Promise<unknown>; isReady(): boolean }[]): boolean {
  const [ready, setReady] = useState(() => parts.every((p) => p.isReady()));
  useEffect(() => {
    if (ready) return;
    let live = true;
    void Promise.allSettled(parts.map((p) => p.fetch())).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [ready, parts]);
  return ready;
}
