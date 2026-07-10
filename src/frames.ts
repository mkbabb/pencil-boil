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
 * Framework-agnostic by design: no `vue` import, no reactivity, no lifecycle. It is a pure
 * memoizer — the `use`-prefix is kept for continuity with the boil vocabulary, not because it
 * is a Vue composable. Any consumer (Vue, canvas, vanilla) can share the cache.
 */

const BOIL_CACHE = new Map<string, unknown>();
const DEFAULT_MAX_ENTRIES = 24;

/** Float-safe key join — non-integers quantize to 4 decimals so tuple keys stay stable. */
function normKey(parts: (string | number)[]): string {
  return parts
    .map((p) => (typeof p === 'number' && !Number.isInteger(p) ? p.toFixed(4) : String(p)))
    .join('|');
}

/**
 * Return the cached value for `cacheKeyParts`, running `compute()` only on a miss. LRU
 * eviction is by `Map` insertion order once the cache exceeds `maxEntries`; a cache hit is
 * touched (re-inserted) to renew its recency.
 */
export function useBoilCache<T>(
  cacheKeyParts: (string | number)[],
  compute: () => T,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
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
  if (BOIL_CACHE.size > maxEntries) {
    const oldest = BOIL_CACHE.keys().next().value;
    if (oldest !== undefined) BOIL_CACHE.delete(oldest);
  }
  return value;
}

/**
 * Frame-array specialization of {@link useBoilCache}: `generateAll` must return exactly the
 * frames to cache as one array. Delegates to the shared LRU, so `useBoilCache` and
 * `useBoilFrames` never fight over two separate caps.
 */
export function useBoilFrames<T>(
  cacheKeyParts: (string | number)[],
  generateAll: () => T[],
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): T[] {
  return useBoilCache<T[]>(cacheKeyParts, generateAll, maxEntries);
}
