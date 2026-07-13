/**
 * useBoilCache / useBoilFrames — a memoizing value cache for boil work.
 *
 * Boil-frame generators (grid lines, divider strokes) and other prebake work are pure
 * functions of a parameter tuple, but recomputing the result on every board/config change is
 * wasteful when the same tuple recurs. `useBoilCache` wraps a generator behind an
 * explicit-key, insertion-order LRU `Map` (default cap 24) — the generator runs only on a
 * cache miss.
 *
 * `useBoilCache<T>` is the general primitive: it caches ONE computed `T` (a frame array, a
 * serialized path, a points ring — anything pure of its key). `useBoilFrames<T>` is the
 * historical frame-array shape, now a thin `useBoilCache<T[]>` wrapper kept for the consumers
 * that import it by name; both share the SAME underlying LRU so one cap governs all boil
 * memoization.
 *
 * DISPOSAL (0.9.2): a cached value may own a native resource the GC cannot reclaim — an
 * `ImageBitmap` (its decoded pixels live off-heap), an object URL, a WebGL handle. Such a
 * value passes an `onEvict` disposer at its first miss; the disposer is bound to THAT key's
 * value and fires exactly once, when the value leaves the cache by LRU eviction. Binding the
 * disposer per-value (not per-call) is load-bearing: the shared LRU mixes types — a raster
 * `ImageBitmap` and a plain frame-string array coexist — so a bitmap consumer's eviction of
 * an array entry must run the ARRAY's disposer (none), never the bitmap consumer's `close`.
 *
 * Framework-agnostic by design: no `vue` import, no reactivity, no lifecycle. It is a pure
 * memoizer — the `use`-prefix is kept for continuity with the boil vocabulary, not because it
 * is a Vue composable. Any consumer (Vue, canvas, vanilla) can share the cache.
 */

const BOIL_CACHE = new Map<string, unknown>();
/** Per-key disposer, bound to the value stored under that key. Sparse: only keyed entries
 *  that passed an `onEvict` appear here. Cleared in lockstep with the cache entry. */
const BOIL_DISPOSERS = new Map<string, (value: unknown) => void>();
const DEFAULT_MAX_ENTRIES = 24;

/** Float-safe key join — non-integers quantize to 4 decimals so tuple keys stay stable. */
function normKey(parts: (string | number)[]): string {
  return parts
    .map((p) => (typeof p === 'number' && !Number.isInteger(p) ? p.toFixed(4) : String(p)))
    .join('|');
}

/** Evict the current oldest entry, running ITS OWN disposer (if any) with its value. */
function evictOldest(): void {
  const oldest = BOIL_CACHE.keys().next().value;
  if (oldest === undefined) return;
  const evicted = BOIL_CACHE.get(oldest);
  BOIL_CACHE.delete(oldest);
  const dispose = BOIL_DISPOSERS.get(oldest);
  if (dispose) {
    BOIL_DISPOSERS.delete(oldest);
    dispose(evicted);
  }
}

/**
 * Return the cached value for `cacheKeyParts`, running `compute()` only on a miss. LRU
 * eviction is by `Map` insertion order once the cache exceeds `maxEntries`; a cache hit is
 * touched (re-inserted) to renew its recency.
 *
 * `onEvict`, when supplied at a key's first miss, is remembered against that key's value and
 * invoked with the value when it is later evicted — the disposal seam for a cached resource
 * (e.g. `(bitmap) => bitmap.close()`). It runs ONCE per stored value, never on a cache hit,
 * never on the evicting call's own value; a subsequent hit for the same key does not re-bind
 * it. A value with no native resource simply omits it (the historical two-/three-arg calls).
 */
export function useBoilCache<T>(
  cacheKeyParts: (string | number)[],
  compute: () => T,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
  onEvict?: (value: T) => void,
): T {
  const key = normKey(cacheKeyParts);
  if (BOIL_CACHE.has(key)) {
    const cached = BOIL_CACHE.get(key) as T;
    BOIL_CACHE.delete(key); // touch for LRU recency
    BOIL_CACHE.set(key, cached);
    return cached;
  }
  const value = compute();
  BOIL_CACHE.set(key, value);
  if (onEvict) BOIL_DISPOSERS.set(key, onEvict as (value: unknown) => void);
  if (BOIL_CACHE.size > maxEntries) evictOldest();
  return value;
}

/**
 * Frame-array specialization of {@link useBoilCache}: `generateAll` must return exactly the
 * frames to cache as one array. Delegates to the shared LRU, so `useBoilCache` and
 * `useBoilFrames` never fight over two separate caps. `onEvict` forwards through for the rare
 * frame value that owns a resource (usually none — arrays are GC-reclaimed).
 */
export function useBoilFrames<T>(
  cacheKeyParts: (string | number)[],
  generateAll: () => T[],
  maxEntries: number = DEFAULT_MAX_ENTRIES,
  onEvict?: (value: T[]) => void,
): T[] {
  return useBoilCache<T[]>(cacheKeyParts, generateAll, maxEntries, onEvict);
}
