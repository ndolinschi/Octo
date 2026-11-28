/**
 * Tiny O(1) bounded LRU cache backed by JS `Map` insertion order.
 * Prevents long-running sessions from retaining unbounded file diffs in memory.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Reads `key` without mutating order (safe to call during React render). */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Reads `key` and refreshes its recency. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined && !this.map.has(key)) return undefined;
    this.map.delete(key);
    this.map.set(key, v as V);
    return v;
  }

  /** Stores `key` as most-recently-used, evicting the oldest entry if over capacity. */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
