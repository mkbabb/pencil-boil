# Changelog

## 0.5.1 — 2026-07-06 (grand-uplift W12 release train)

`useBoilFrames<T>(cacheKeyParts, generateAll, maxEntries?)` — a memoizing frame-set cache.
Wraps a pure boil-frame generator behind an explicit-key, insertion-order LRU `Map` (default
cap 24): the generator runs only on a cache miss, a hit is touched for recency, and
non-integer key parts quantize to 4 decimals so float tuples key stably. Framework-agnostic
(no `vue` import) — a pure memoizer any consumer can share, promoting the ad-hoc frame-cache
discipline hand-rolled in the sudoku consumer's `gridPaths.ts` into the library.

## 0.5.0 — 2026-07-06 (grand-uplift W12 release train)

The unified boil scheduler. One rAF chain now drives every boil consumer through a generic
`advance(steps)` dispatch, and a second subscriber kind—`sequence`—rides the same chain as a
one-shot eased `0→1` wall-clock tween that self-unsubscribes on completion (the draw-in and
celebration substrate). `useLineBoil`'s signature and return shape are unchanged; every
existing consumer keeps working untouched.

**Reactive prefers-reduced-motion, with correct teardown (M2).** `prefersReducedMotion()` is
no longer a fresh `matchMedia` read inside `start()` — the scheduler holds a reactive `prmRef`
backed by a `matchMedia` `'change'` listener, surfaced as
`usePrefersReducedMotion(): Readonly<Ref<boolean>>`. The defect a naive reactive patch misses:
when PRM flips to `reduce` mid-session, `start()`'s early return guards only *new* enrolment
and never withdraws an *already-active* subscriber. The `watchEffect` gate now reads
`prmRef.value` unconditionally and owns the teardown branch, and the central `'change'`
listener hard-clears every subscriber — reactive or imperative — the instant PRM engages.

**Centralized scheduler surface** (all additive): `useBoilFrame` (alias of `useLineBoil`),
`useFilterParamBoil` (per-tick side effect on the shared chain), `createBoilTicker`
(imperative ping-pong wiggle), `createSequenceSubscription` + the `SequenceHandle`/`BoilHandle`
types, `schedulerDebugInfo`, and the easing curves
(`easeOutCubic`/`easeInCubic`/`easeInOutCubic`/`linear`/`resolveEasing`/`Easing`). The single
chain is held through idempotent start/stop, and the `visibilitychange` resume now checks for
an active subscriber first — fixing a 0.4.1 defect where returning to a tab resumed an empty
idle rAF loop with zero subscribers.

**Boil-hold gate**: `acquireHold`/`releaseHold`/`isBoilHeld`/`heldFrameCount` — a freeze
contract layered on the scheduler with no second chain. A hold collapses a wrapped frame-count
getter to `1`, so a subscriber freezes in place on its current frame (no snap to 0) and
re-enrols mid-cadence on release.

## 0.4.1 — 2026-06-10

`useLineBoil` no longer subscribes static marks to the singleton rAF scheduler. `start()`
gates on `getFrameCount() > 1` (a second, independent gate alongside `prefersReducedMotion()`),
and the composable enrols/withdraws reactively from the live frame count via a `watchEffect`.
A single-frame mark (a `draw-on` brush) animates nothing, so it never arms the loop; a
`draw-then-boil` mark enrols the instant its count crosses 1 and withdraws if it drops back.
With zero active subscribers the scheduler disarms and stops re-arming, so a page of only
static marks costs zero frames. Locked by the in-repo `boil-guard` proof.

## 0.4.0 — 2026-06-10 (tranche-C handmark cohort)

Adds `ellipsePoints` to `path.ts` — a seeded wobble ellipse returned as a closed
point ring with a hand-circled overshoot (the sweep runs past 2π so the ring crosses
its own start). It follows the IR-first convention of `wobbleLinePoints`: it emits
`[number, number][]`, so the ring boils via `perturbPointsClosed` and serialises via
`catmullRomToBezier` — the same contract as every other primitive. This is the sole
geometry `@mkbabb/glass-ui`'s new `./handmark` component (positioned circle mode)
required upstream; no other surface changed. Exported from `src/index.ts`.

## 0.3.0 — 2026-05-28 (G.W5 cohort)

The current published version, seeded as the initial CHANGELOG entry as part of the
muster tranche G release-engineering wave (G.W5 sub-wave D). Future entries accrete
from changesets.

`@mkbabb/pencil-boil@0.3.0` ships the hand-drawn line + boil geometry toolkit:
seeded roughen/boil generators, the `perturbPointsClosed` closed-polygon perturbation,
a singleton-RAF scheduler powering `useLineBoil` (replacing per-instance RAF), and the
celestial decorative helpers (`wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays`).
The package ships TypeScript source directly — consumers compile it through their own
bundler. Consumed by `bbnf-buddy` + `fourier-analysis`.
