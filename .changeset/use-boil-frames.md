---
"@mkbabb/pencil-boil": minor
---

`useBoilFrames<T>(cacheKeyParts, generateAll, maxEntries?)` — a memoizing frame-set cache.
Wraps a pure boil-frame generator behind an explicit-key, insertion-order LRU `Map` (default
cap 24): the generator runs only on a cache miss, a hit is touched for recency, and
non-integer key parts quantize to 4 decimals so float tuples key stably. Framework-agnostic
(no `vue` import) — a pure memoizer any consumer can share, promoting the ad-hoc frame-cache
discipline sudoku hand-rolled in `gridPaths.ts` into the library.
