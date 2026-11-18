/**
 * Warming the chunks of lazy surfaces (palette, model list, Settings, tool tabs) so their first open is as fast as the second.
 * Each surface registers its loader under a key (`registerWarm`, next to its `readyLazy`). When to warm (on idle, on intent,
 * not under Save-Data) is `lib/warmSchedule`, its own chunk: the entry carries only this registry.
 */

type Loader = () => Promise<unknown>;

const loaders = new Map<string, Loader[]>();
const started = new Set<string>();

/** `key`'s surface loads with `load` (several loaders may share a key: a tab and its editor). */
export function registerWarm(key: string, load: Loader): void {
  const list = loaders.get(key);
  if (list) list.push(load);
  else loaders.set(key, [load]);
}

/** Starts `key`'s loaders once; a failed load is forgotten so the next intent (or the real open) tries again. */
export function warm(key: string): Promise<unknown> {
  const list = loaders.get(key);
  if (!list || started.has(key)) return Promise.resolve();
  started.add(key);
  return Promise.all(list.map((load) => load())).catch(() => {
    // The surface's own open loads it again and shows the failure there.
    started.delete(key);
  });
}
