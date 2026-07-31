# Changelog

## 0.10.0 — 2026-07-31 (the capture-intrinsic truth-fix)

### Fixed

`rasterizePose` stamps the capture size (`round(cssSize × dpr)`) as the pose document's
intrinsic `width`/`height` between serialize and blob. WebKit pins a filtered SVG-as-image
raster at its *declared* intrinsic and bilinearly upscales into the `drawImage` dest —
measured 2.08–3.12× soft on a 200-unit celestial pose, 3.73–5.60× on a text logo, flat
across dpr2→dpr3 (extra dpr bought zero detail). The `viewBox` is untouched: user space is
preserved; only render resolution moves. A pose root without a `viewBox` now throws a named
error instead of baking silently wrong. Minor bump: every caller's bitmaps change — they
sharpen, with zero call-site diff.

`useRasterStack` no longer captures at a non-positive `cssSize`; the bake defers until the
reactive box lands. An `<svg>` host has no `offsetWidth`, so a size seeded from
`useElementSize` starts at 0 — 0.9.2 baked a fallback-sized stack first and re-baked after,
shipping one wrong-resolution paint.

## 0.9.2 — 2026-07-13 (mobile recut: the residency seam)

`useBoilCache` / `useBoilFrames` gain a fourth argument, `onEvict?: (value) => void` — a
**per-value disposer** bound to a stored value at its first miss and invoked once, with that
value, when it leaves the cache by LRU eviction. It is the disposal seam a cached native
resource needs: the GC cannot reclaim an `ImageBitmap`'s off-heap decoded pixels, so a raster
consumer passes `(bitmap) => bitmap.close()` and the LRU stops accreting dead bitmaps as the
board/theme churns. Binding the disposer **per value, not per call** is load-bearing — the
shared LRU mixes types, so a bitmap consumer that evicts a plain frame-array entry runs the
array's disposer (none), never `close` on a string. Back-compatible: the arg is optional and
the two-/three-arg calls are unchanged.

`useRasterStack` no longer memoizes its per-pose bitmaps through the shared LRU. It captures
each pose **fresh per bake**. The consumer of a raster stack now owns each bitmap's lifecycle
(convert it to an object URL for the `<image>`/`<img>` decode, then `close()` the redundant
bitmap), so the double residency dies: the decoded `<image>` PLUS the retained `ImageBitmap`
of the same pixels. A cross-bake memo would have re-handed a consumer-closed bitmap to a
warm re-bake (a poisoned re-display); fresh-per-bake is the price of letting the redundant
copy be freed. A warm theme flip-back re-rasterizes instead of reusing, which is cheap under
the Bloom mask and a DPR cap and never risks a closed bitmap.

## 0.9.1 — 2026-07-13 (currency bump)

Currency bump — no library surface change; the dep set catches up and the toolchain
contract lands in the manifest.

`vue` devDep floats to **3.5.39**, which pulls `@vue/compiler-sfc@3.5.39 → postcss@8.5.18`
and kills the one live advisory the lockfile carried: **GHSA-qx2v-qp2m-jg93** (PostCSS XSS
via an unescaped `</style>` in the CSS stringify output, `postcss <8.5.10`). `npm audit` now
reads **0 vulnerabilities**; any downstream that lints or builds the SFC path stops
inheriting it.

`typescript` devDep jumps two majors, `^5.7.0 → ^7.0.2` (the Go-port native compiler).
`tsc --noEmit` (the `check` gate), the full proof suite, and the Playwright browser proofs
all pass clean under 7.0.2 — the proofs run on Node's native type-stripping, so the major
touches only the type gate, which stays green.

`engines` and `packageManager` now declare the contract the tree only ever documented in
prose: `node >=24`, `npm >=11` (npm 10 mis-resolves the lockfile), pinned to `npm@11.12.1`.
A fresh clone on an old npm now trips a gate instead of a silent mis-resolution.

## 0.9.0 — 2026-07-12 (raster surface)

Bake once, swap forever — the WebKit raster cure, shipped as library surface.

WebKit does not cache a filtered-SVG raster across an opacity flip: a resident
`feTurbulence + feDisplacementMap` stack re-executes the whole filter chain in the GPU
process on every beat (~150–224 ms board-area raster on the critical frame path, ~2 cores
at idle, single-digit fps). The cure is to capture each frozen pose to an `ImageBitmap`
ONCE and opacity-swap the bitmaps on the beat — no filter re-executes at steady state, in
either engine.

`raster.ts` (browser-only, framework-agnostic — no `vue` import) is the capture.
`serializePoseSvg` frames structured `PoseSvgParts` into a self-contained SVG document;
`isSelfContainedSvg` is the Node-provable half of the identity guard (a `currentColor` /
`var()` leak fails deterministically without a browser); `rasterizePose` captures one
self-contained pose to a bitmap at device DPR via same-origin SVG→`Blob`→`drawImage`,
throwing on a cascade leak rather than baking a fallback color into the pixels; and
`rasterizePoseStack` captures the whole pose-indexed array in one call.

`useRasterStack(opts, stepEveryBeats?)` (`vue.ts`) orchestrates the bake: the pose advances
off the shared beat (through `useLineBoil`, so the same scheduler / PRM / visibility gates
carry), each bitmap memoizes through `useBoilCache` under `(cacheKey, pose, dpr, cssSize)`,
and it re-bakes on the pixel-changing triggers — DPR (a monitor drag), theme flip (the
consumer folds theme into `cacheKey`), and `document.fonts.ready` (a `<text>` pose must bake
the real face, not the fallback). `bitmaps` is null while a bake is in flight, so the
consumer holds the live-filter fallback (one filtered raster per appearance, the sanctioned
transient); a monotonic bake token discards a superseded resolution.

The identity gate the Node harness cannot see (no canvas / `ImageBitmap` / SVG layout) now
runs in a real engine: `npm run proof:browser` (Playwright) exercises the SHIPPED
`rasterizePose` in chromium AND webkit at DPR2 and asserts untainted + byte-identical
re-raster + distinct-per-pose + capture-vs-live SSIM >= 0.98 — a per-engine tolerance floor,
not equality, because WebKit's canvas-filter and compositor-filter paths diverge ~1px at
displacement edges by design (there is NO cross-engine parity gate; `feTurbulence` differs
by engine). CI gains a `browser-proof` job alongside the existing `gates`.

`useBoilFrame` (the `useLineBoil` alias) is DROPPED — one canonical name for the frame
cycler.

The changesets rig is retired: `.changeset/` is deleted and releases are cut by hand — bump
`package.json`, write this `CHANGELOG.md` entry, push a `vX.Y.Z` tag; the tag fires
`release.yml` (type gate → `npm publish` under `NPM_TOKEN`). CONTRIBUTING documents the
honest tag-push flow.

Every prior signature carries forward unchanged; the raster surface is purely additive.

## 0.8.1 — 2026-07-11

One clock for the beat, end to end. 0.8.0's tick elapsed frame subscribers on the rAF
animation timestamp while the beat timer aims in `performance.now()` terms — and the frame
timestamp trails the wall clock by a few ms, so the wake's own tick read `elapsed <
interval`, advanced nothing, and burned a steps=0 retry frame EVERY beat (2 rAF/beat,
traced live: 16 main frames/s where 8 was the contract). Frame subscribers now elapse on
`performance.now()` — the clock the timer aims with; sequences keep the rAF timestamp
(they're animations, frame time is their truth). Traced after: 7.98 main frames/s at an
8Hz beat, exactly one rAF per beat.

## 0.8.0 — 2026-07-11 (scheduler park)

The scheduler retimed off vsync — the tick is a poll no more; the beat is a clock.

The frame-only steady state no longer spins a perpetual rAF chain (the old shape polled an
8Hz stop-motion clock at vsync resolution: ~98 empty BeginMainThreadFrame/s on a settled
page). It now PARKS: `setTimeout` aimed at the earliest
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

## 0.7.0 — 2026-07-10 (prebake + draw-in surface)

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

## 0.6.0 — 2026-07-06 (celestial generator proofs)

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

## 0.5.1 — 2026-07-06 (frame-set cache)

`useBoilFrames<T>(cacheKeyParts, generateAll, maxEntries?)` — a memoizing frame-set cache.
Wraps a pure boil-frame generator behind an explicit-key, insertion-order LRU `Map` (default
cap 24): the generator runs only on a cache miss, a hit is touched for recency, and
non-integer key parts quantize to 4 decimals so float tuples key stably. Framework-agnostic
(no `vue` import) — a pure memoizer any consumer can share, promoting the ad-hoc frame-cache
discipline hand-rolled in the sudoku consumer's `gridPaths.ts` into the library.

## 0.5.0 — 2026-07-06 (unified boil scheduler)

The unified boil scheduler. One rAF chain now drives every boil consumer through a generic
`advance(steps)` dispatch, and a second subscriber kind—`sequence`—rides the same chain as a
one-shot eased `0→1` wall-clock tween that self-unsubscribes on completion (the draw-in and
celebration substrate). `useLineBoil`'s signature and return shape are unchanged; every
existing consumer keeps working untouched.

**Reactive prefers-reduced-motion, with correct teardown (M2).** `prefersReducedMotion()` is
no longer a fresh `matchMedia` read inside `start()`; the scheduler holds a reactive `prmRef`
backed by a `matchMedia` `'change'` listener, surfaced as
`usePrefersReducedMotion(): Readonly<Ref<boolean>>`. The defect a naive reactive patch misses:
when PRM flips to `reduce` mid-session, `start()`'s early return guards only *new* enrolment
and never withdraws an *already-active* subscriber. The `watchEffect` gate now reads
`prmRef.value` unconditionally and owns the teardown branch, and the central `'change'`
listener hard-clears every subscriber (reactive or imperative) the instant PRM engages.

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

## 0.4.0 — 2026-06-10 (ellipse primitive)

Adds `ellipsePoints` to `path.ts` — a seeded wobble ellipse returned as a closed
point ring with a hand-circled overshoot (the sweep runs past 2π so the ring crosses
its own start). It follows the IR-first convention of `wobbleLinePoints`: it emits
`[number, number][]`, so the ring boils via `perturbPointsClosed` and serialises via
`catmullRomToBezier` — the same contract as every other primitive. This is the sole
geometry `@mkbabb/glass-ui`'s new `./handmark` component (positioned circle mode)
required upstream; no other surface changed. Exported from `src/index.ts`.

## 0.3.0 — 2026-05-28 (initial changelog seed)

The first version to carry a hand-written CHANGELOG entry; it was the published baseline
when this file began. Later entries are written by hand at each version bump.

`@mkbabb/pencil-boil@0.3.0` ships the hand-drawn line + boil geometry toolkit:
seeded roughen/boil generators, the `perturbPointsClosed` closed-polygon perturbation,
a singleton-RAF scheduler powering `useLineBoil` (replacing per-instance RAF), and the
celestial decorative helpers (`wobbleDiamond`, `wobbleStarPolygon`, `generateSunRays`).
The package ships TypeScript source directly — consumers compile it through their own
bundler. Consumed by `bbnf-buddy` + `fourier-analysis`.
