# Changelog

## 0.8.0 — 2026-07-11 (tranche-3 W13 §1-P1 release)

The scheduler retimed off vsync — the tick is a poll no more; the beat is a clock.

The frame-only steady state no longer spins a perpetual rAF chain (the old shape polled an
8Hz stop-motion clock at vsync resolution: ~98 empty BeginMainThreadFrame/s on a settled
page, measured in the T3-W13 audit). It now PARKS: `setTimeout` aimed at the earliest
active frame subscriber's next beat boundary → ONE `requestAnimationFrame` to land the
writes inside a frame → sleep. Between beats there is no outstanding rAF and no main-thread
frame scheduling on the scheduler's account. Per-subscriber `lastTick` anchor arithmetic
keeps the beat drift-free regardless of wake jitter (a few ms at 8fps is sub-perceptual).

`sequence` subscribers (draw-ins, flourishes, tweens) keep the continuous rAF chain WHILE
they run — any active sequence supersedes the park; completion falls back to it. PRM and
tab-visibility gates carry unchanged, now cancelling whichever wake shape is pending
(hidden-tab `setTimeout` throttling is a second free layer of the same parking). The
single-tick invariant strengthens the old single-chain one: at most ONE pending wake —
beat timer or rAF, never both.

Every public signature carries forward unchanged. `schedulerDebugInfo()` gains a `parked`
field; its `chains` still truthfully reads the live rAF, so a settled boiling page now
reports `chains: 0, parked: true` with a one-frame `chains: 1` blip as each beat lands.
Proof (g) locks the sleeping steady state: no rAF at rest, exactly one rAF per beat,
re-park after every tick, sequence supersede-and-fallback, withdrawal disarms both shapes.

## 0.7.0 — 2026-07-10 (tranche-2 W5 release)

Prebake + draw-in surface, hoisted out of the consumer that hand-rolled it.

`useBoilCache<T>(cacheKeyParts, compute, maxEntries?)` — the general memoizer under
`useBoilFrames`. It caches ONE computed `T` (a frame array, a serialized path, a points ring)
behind the same explicit-key insertion-order LRU (default cap 24). `useBoilFrames<T>` is now a
thin `useBoilCache<T[]>` wrapper over the SAME underlying `Map`, so one cap governs all boil
memoization rather than two APIs fighting over separate caches.

`boilLineFrames(x1, y1, x2, y2, frameCount, boilAmount, options?)` and
`boilRectFrames(x, y, w, h, frameCount, boilAmount, options?)` — the base → perturb → serialize
loop every consumer wrote by hand, in one call. The base wobble skeleton is generated once,
then each frame shivers off it under a distinct seed (frame 0 is the un-perturbed base). Pure
of their arguments, so they pair directly with `useBoilCache([...key], () => boilLineFrames(...))`.

`createStrokeDrawIn(pathEl, { pathLength?, durationMs?, delayMs?, easing?, onComplete? })` — the
canonical `sequence` consumer, hoisted from the sudoku glyph layer. Tweens stroke-dashoffset
from the path's full length to `0` on the one shared rAF chain, clears the dash array on
completion (`strokeDasharray: 'none'`) so the settled stroke is solid even when `pathLength` is
approximate, and under `prefers-reduced-motion` paints the solid end state immediately without
enrolling on the chain. `pathLength` defaults to the element's own `getTotalLength()`.

Docs: README module map reflects the actual surface (`frames.ts`, `boilHoldGate.ts`, the full
scheduler export list) and folds the manual perturb loop into the `boilLineFrames` +
`useBoilCache` one-liner; CONTRIBUTING documents `npm run proof` / `npm test` (CI has run the
proofs since 0.6.0, the doc said only `check`).

The scheduler is untouched — one rAF chain, the `chains=1` / floor-`subscribers` invariant,
reactive-PRM teardown, and every existing signature carry forward unchanged.

## 0.6.0 — 2026-07-06 (grand-uplift W12 release train)

Celestial generator proofs. `proofs/celestial.proof.ts` locks the point-count, determinism,
and seed-stability invariants of `wobbleDiamond` (4 vertices), `wobbleStarPolygon` (10), and
`generateSunRays` (20 points per polygon): a fixed seed always emits the same SVG `points`
string, distinct seeds diverge, every coordinate is finite. CI now runs `npm test`
(`tsc --noEmit` plus every proof — scheduler, frame cache, celestial), so the proof scripts
execute on every push rather than sitting un-gated.

`useCelestialSun()` stays **parked** — its second live consumer never materialized (both
candidate repos standardized their dark-mode chrome elsewhere), so shipping a one-consumer
composable would be speculative surface. The primitives it would compose are all exported and
now proof-covered; the composable lands when a real second consumer does.

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
