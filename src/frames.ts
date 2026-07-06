/**
 * useBoilFrames — a memoizing frame-set cache.
 *
 * Boil-frame generators (grid lines, divider strokes) are pure functions of a parameter
 * tuple, but recomputing an entire frame set on every board/config change is wasteful when
 * the same tuple recurs. `useBoilFrames` wraps a generator behind an explicit-key,
 * insertion-order LRU `Map` (default cap 24) — the generator runs only on a cache miss.
 *
 * Framework-agnostic by design: no `vue` import, no reactivity, no lifecycle. It is a pure
 * memoizer — the `use`-prefix is kept for continuity with the boil vocabulary, not because
 * it is a Vue composable. Any consumer (Vue, canvas, vanilla) can share the cache.
 */

const FRAME_CACHE = new Map<string, unknown[]>();
const DEFAULT_MAX_ENTRIES = 24;

/** Float-safe key join — non-integers quantize to 4 decimals so tuple keys stay stable. */
function normKey(parts: (string | number)[]): string {
  return parts
    .map((p) => (typeof p === 'number' && !Number.isInteger(p) ? p.toFixed(4) : String(p)))
    .join('|');
}

/**
 * Return the cached frame set for `cacheKeyParts`, running `generateAll()` only on a miss.
 * `generateAll` must return exactly the frames to cache as one array. LRU eviction is by
 * `Map` insertion order once the cache exceeds `maxEntries`; a cache hit is touched to renew
 * its recency.
 */
export function useBoilFrames<T>(
  cacheKeyParts: (string | number)[],
  generateAll: () => T[],
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): T[] {
  const key = normKey(cacheKeyParts);
  const cached = FRAME_CACHE.get(key);
  if (cached) {
    FRAME_CACHE.delete(key); // touch for LRU recency
    FRAME_CACHE.set(key, cached);
    return cached as T[];
  }
  const frames = generateAll();
  FRAME_CACHE.set(key, frames);
  if (FRAME_CACHE.size > maxEntries) {
    const oldest = FRAME_CACHE.keys().next().value;
    if (oldest !== undefined) FRAME_CACHE.delete(oldest);
  }
  return frames;
}
