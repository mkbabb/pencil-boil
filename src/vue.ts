/**
 * Unified frame-index scheduler — one beat-aligned tick, app-wide, asleep between beats.
 *
 * Every boil consumer funnels into the SAME module-level `subscribers` Set and the
 * SAME single scheduler tick:
 *
 * - path-boil frame cycling — `useLineBoil`: advance a discrete frame ref modulo a frame
 *   total every N ms.
 * - imperative glyph wiggle / any per-tick side effect — `createBoilTicker` (ping-pongs a
 *   frame index; created after mount, owns its own start/stop).
 * - one-shot eased draw-ins / flourishes — `createSequenceSubscription` (the
 *   `sequence` kind: a wall-clock tween that self-unsubscribes on completion).
 *
 * However many things want to advance on a clock, there is exactly one tick doing the
 * advancing — and the tick is timed to the clock it serves, not to vsync:
 *
 * - `frame` subscribers are a BEAT (a ~125ms stop-motion clock), so the scheduler
 *   parks on a `setTimeout` aimed at the earliest subscriber's next boundary, wakes,
 *   lands the writes inside ONE `requestAnimationFrame` (no tearing), and sleeps
 *   again. Between beats there is NO outstanding rAF and the main thread schedules
 *   no frames on the scheduler's account. (The old shape — a perpetual rAF chain
 *   polling an 8Hz clock at vsync resolution — cost ~98 empty main frames/s on a
 *   settled page; measured in the T3-W13 audit, `b1-test-g.json`: 0 paints, 98.4
 *   BeginMainThreadFrame/s.) Timer jitter of a few ms at 8fps stop-motion is
 *   sub-perceptual; the per-subscriber `lastTick` anchor arithmetic keeps the beat
 *   drift-free regardless of when the wake actually fires.
 * - `sequence` subscribers are eased tweens that want every frame WHILE they run, so
 *   any active sequence holds the continuous rAF chain — transient by construction
 *   (they self-unsubscribe), after which the scheduler falls back to beat parking.
 *
 * Two gates apply uniformly to every subscriber, whichever call shape enrolled it:
 *
 * 1. `prefers-reduced-motion` — reactive (`prmRef`) AND centrally enforced. The
 *    `matchMedia` 'change' listener doesn't merely flip a ref for each consumer's own
 *    watchEffect to notice (that shape has a residual bug: a watchEffect that re-runs
 *    `start()` post-flip can miss the teardown branch — the M2 defect). The instant PRM
 *    engages, the listener force-clears every subscriber and cancels the rAF directly —
 *    so correctness never depends on N independently-written watchEffects, and it reaches
 *    the imperative (`createBoilTicker` / `createSequenceSubscription`) handles, which
 *    aren't Vue-reactive at all (created well after any component's synchronous setup, so
 *    they have no watchEffect to hook into).
 * 2. Tab visibility — cancels the pending wake (beat timer or rAF) on `hidden`
 *    (0 ticks), resets every active frame subscriber's `lastTick` on `visible`, then
 *    re-arms ONLY if a subscriber is still active (a page of zero subscribers never
 *    resumes an empty idle loop). Hidden-tab `setTimeout` throttling is a second,
 *    free layer of the same parking should a wake ever slip the gate.
 */

import {
  computed,
  nextTick,
  onScopeDispose,
  onUnmounted,
  ref,
  toValue,
  watch,
  watchEffect,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import { easeOutCubic, linear, type Easing } from './easings';
import { rasterizePoseToBlob, type RasterStackOptions } from './raster';

function normalizeFrameCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value)) return 125;
  return Math.max(16, Math.floor(value));
}

// ── subscriber kinds (one chain, two dispatch shapes) ──
//
// `frame` — advance a discrete frame index every N ms (path-boil, filter-param ticking,
//   glyph wiggle). Perpetual until stopped; anchored to a `lastTick` wall-clock.
// `sequence` — ease a continuous 0→1 progress over a fixed wall-clock duration, then
//   self-unsubscribe (glyph/grid draw-in, a celebration flourish, a garnish draw-on).
//
// Both ride the SAME `subscribers` Set and the SAME single rAF chain — however many
// draw-ins and flourishes crest at once, there is exactly one outstanding rAF.

interface FrameSubscriber {
  kind: 'frame';
  advance: (steps: number) => void;
  getInterval: () => number;
  lastTick: number;
  active: boolean;
}

interface SequenceSubscriber {
  kind: 'sequence';
  /** performance-clock ms of the tween's t=0 (may sit in the future to express a delay). */
  startTime: number;
  durationMs: number;
  easing: Easing;
  onProgress: (eased: number, raw: number) => void;
  onComplete: () => void;
  active: boolean;
}

type Subscriber = FrameSubscriber | SequenceSubscriber;

const subscribers = new Set<Subscriber>();
let rafId: number | null = null;
let beatTimer: ReturnType<typeof setTimeout> | null = null;
let beatDue = Infinity; // performance-clock ms of the pending beat wake (Infinity = none)
let schedulerRunning = false;

// ── single-tick invariant ──
// At any instant the scheduler holds AT MOST ONE pending wake: either a beat timer
// (`beatTimer`, frame-only parking) or an outstanding rAF (`rafId`, a beat landing its
// writes / a sequence holding the continuous chain) — never both. `startChain`/`armBeat`/
// `stopChain` are the ONLY places either handle is created or cancelled outside
// `schedulerTick`'s own tail; `startChain` is idempotent on `rafId` and supersedes any
// pending beat timer. Every path (enrol, visibility resume, PRM, the tick tail) funnels
// through `armScheduler`, so a resume that races the browser's frame commit can never
// spawn a second, untracked loop.

function clearBeatTimer() {
  if (beatTimer !== null) {
    clearTimeout(beatTimer);
    beatTimer = null;
  }
  beatDue = Infinity;
}

/** Arm the CONTINUOUS rAF chain (sequence mode / the one frame that lands a beat). */
function startChain() {
  if (typeof requestAnimationFrame === 'undefined') return;
  if (rafId !== null) return;
  clearBeatTimer(); // the chain supersedes a pending beat wake — one pending tick, ever
  rafId = requestAnimationFrame(schedulerTick);
}

function stopChain() {
  clearBeatTimer();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function hasActiveSubscriber(): boolean {
  for (const sub of subscribers) {
    if (sub.active) return true;
  }
  return false;
}

function hasActiveSequence(): boolean {
  for (const sub of subscribers) {
    if (sub.active && sub.kind === 'sequence') return true;
  }
  return false;
}

/**
 * Park until the earliest active frame subscriber's next beat boundary, then land the
 * writes inside ONE rAF (the timer callback arms the chain; the tick tail re-parks).
 *
 * A fresh subscriber (`lastTick === 0`) anchors to enrolment time here — the same
 * "first boundary is one interval out" semantics the perpetual chain's first tick gave
 * it. An interval that shortens mid-sleep waits out the already-pending wake (at most
 * one stale beat, self-correcting on the next park); one that lengthens costs at most
 * one idle wake (steps=0) before re-parking on the new boundary.
 */
function armBeat() {
  if (rafId !== null) return; // a tick is in flight — its tail re-arms
  const now = performance.now();
  let due = Infinity;
  for (const sub of subscribers) {
    if (!sub.active || sub.kind !== 'frame') continue;
    if (sub.lastTick === 0) sub.lastTick = now;
    const subDue = sub.lastTick + sub.getInterval();
    if (subDue < due) due = subDue;
  }
  if (due === Infinity) return; // no active frame subscriber — nothing to wake for
  if (beatTimer !== null) {
    if (due >= beatDue - 1) return; // the pending wake already covers this boundary
    clearBeatTimer(); // an earlier boundary enrolled — re-aim the wake
  }
  beatDue = due;
  beatTimer = setTimeout(() => {
    beatTimer = null;
    beatDue = Infinity;
    // A cancel (PRM engage / tab hidden) clears this timer, but guard anyway — a wake
    // that somehow outlives a disarm must not resurrect the scheduler.
    if (!schedulerRunning) return;
    startChain();
  }, Math.max(0, due - now));
}

/**
 * The one dispatch point: any active sequence holds the continuous rAF chain (it wants
 * every frame, transiently); a frame-only page parks on the beat timer and sleeps.
 */
function armScheduler() {
  if (!schedulerRunning || typeof requestAnimationFrame === 'undefined') return;
  if (hasActiveSequence()) startChain();
  else armBeat();
}

function schedulerTick(timestamp: number) {
  // Frame subscribers elapse on the WALL clock, not the rAF timestamp: the beat timer aims
  // at `lastTick + interval` in performance.now() terms, and the rAF animation timestamp
  // trails performance.now() by a few ms — measured on the frame timestamp, the wake's own
  // tick reads elapsed < interval, advances nothing, and burns a steps=0 retry frame EVERY
  // beat (2 rAF/beat, traced in the T3-W13 gate). One clock for the beat, end to end.
  // Sequences keep the rAF timestamp — they're animations, and frame time is their truth
  // (their performance.now()-anchored start is ±one frame of skew, documented at `start`).
  const wallNow = performance.now();
  // Sequence subscribers self-remove on completion; collect them and fire onComplete AFTER
  // the iteration so a chained flourish enrolled in a callback can't re-enter this same loop
  // (it ticks on the next frame instead).
  let completed: SequenceSubscriber[] | null = null;
  for (const sub of subscribers) {
    if (!sub.active) continue;
    if (sub.kind === 'frame') {
      const interval = sub.getInterval();
      if (sub.lastTick === 0) sub.lastTick = wallNow;
      const elapsed = wallNow - sub.lastTick;
      if (elapsed >= interval) {
        const steps = Math.floor(elapsed / interval);
        sub.lastTick += steps * interval;
        sub.advance(steps);
      }
    } else {
      const raw = (timestamp - sub.startTime) / sub.durationMs;
      if (raw < 0) continue; // still inside the delay window — nothing drawn yet
      if (raw >= 1) {
        sub.onProgress(1, 1);
        sub.active = false;
        (completed ??= []).push(sub);
      } else {
        sub.onProgress(sub.easing(raw), raw);
      }
    }
  }
  if (completed) {
    for (const sub of completed) {
      subscribers.delete(sub);
      sub.onComplete();
    }
  }
  // The rAF that carried this tick is consumed; whatever comes next is a fresh arm.
  rafId = null;
  // A finished sequence may have been the last active subscriber — shut the scheduler
  // down so a settled page returns to the ambient floor rather than spinning empty.
  maybeStopScheduler();
  // Re-arm only while running — a tick that fires after a cancel (PRM engage / tab
  // hidden raced the browser's frame commit) must not resurrect the scheduler. Live
  // sequences keep the continuous chain; a frame-only page parks back on the beat
  // timer and the main thread sleeps until the next boundary.
  if (schedulerRunning) armScheduler();
}

function ensureScheduler() {
  schedulerRunning = true;
  armScheduler();
}

function maybeStopScheduler() {
  if (!schedulerRunning) return;
  if (hasActiveSubscriber()) return;
  schedulerRunning = false;
  stopChain();
}

// ── tab visibility — module-level, shared by every subscriber (0 ticks when hidden) ──

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopChain(); // 0 ticks (beat timer AND rAF both cancelled); schedulerRunning is left intact for resume
    } else if (schedulerRunning && hasActiveSubscriber()) {
      // Resume ONLY with a live subscriber — a page whose marks all withdrew while hidden
      // (or never enrolled) must not resume an empty idle loop. Frame subscribers reset
      // their wall-clock anchor so an elapsed-time jump can't fast-forward every frame index
      // at once. Sequence one-shots have no `lastTick`: a tween that would have finished
      // while hidden completes on the first resumed tick — the correct end state.
      for (const sub of subscribers) if (sub.kind === 'frame') sub.lastTick = 0;
      armScheduler(); // idempotent — resume can never double the pending wake
    } else {
      // No active subscriber: disarm cleanly rather than leaving `schedulerRunning` dangling.
      schedulerRunning = false;
    }
  });
}

// ── prefers-reduced-motion — reactive AND centrally enforced ──

const prmQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

const prmRef = ref(prmQuery?.matches ?? false);

prmQuery?.addEventListener('change', (e) => {
  prmRef.value = e.matches;
  if (e.matches) {
    // Hard-stop every subscriber the instant PRM engages — independent of whether it's a
    // reactive (watchEffect-backed) or imperative handle. This is the teardown the naive
    // "just make prefersReducedMotion() reactive" fix misses (M2): a re-run watchEffect that
    // calls start() again can early-return before withdrawing an already-active subscriber.
    for (const sub of subscribers) sub.active = false;
    subscribers.clear();
    schedulerRunning = false;
    stopChain();
  }
  // Flipping back to false does NOT auto-resume imperative handles; the reactive consumers
  // re-enrol via their own watchEffect gate. Mirrors the visibility discipline (resume is
  // per-consumer, never implicit for imperatively-created tickers).
});

/** The live `prefers-reduced-motion: reduce` state as a reactive ref. */
export function usePrefersReducedMotion(): Readonly<Ref<boolean>> {
  return prmRef;
}

// ── low-level subscription handle ──

export interface BoilHandle {
  start: () => void;
  /** Withdraws the subscriber. NEVER throws, in any lifecycle phase — see the contract above. */
  stop: () => void;
}

// ── THE stop() NO-THROW CONTRACT (0.11.0) ──
//
// Every `stop()` this module hands out returns without throwing, in every lifecycle phase:
// before start, mid-flight, from inside its own tick, after completion, twice, after a
// central PRM clear, after teardown. A caller never needs `try { h.stop() } catch {}` — and
// a codebase carrying those wrappers cannot tell a reader whether they defend against a real
// throw or hide a lifecycle bug, which is why the guarantee belongs here.
//
// The withdrawal is ORDERED so the contract costs nothing in truth: the two statements that
// must land are total by construction (a boolean write and `Set.delete`), and they run
// FIRST. Only the host-facing teardown can throw — `cancelAnimationFrame` / `clearTimeout`
// are patchable by an embedding page (analytics shims, zone-style monkey-patches, a
// torn-down iframe's dead `window`) — and by the time it runs the subscriber is already out
// of the set, so a throwing host cannot leave a withdrawn subscriber enrolled. That is the
// negative control `proofs/stop-contract.proof.ts` asserts alongside the no-throw arms: the
// swallow hides nothing, because nothing that matters happens after it.
function withdraw(sub: Subscriber): void {
  sub.active = false;
  subscribers.delete(sub);
  try {
    maybeStopScheduler();
  } catch {
    // `maybeStopScheduler` writes `schedulerRunning = false` BEFORE it cancels, so the
    // module's own state is already consistent; what threw is the host's timer API, and
    // whatever it leaked is the host's. stop() returns.
  }
}

function createSubscription(
  advance: (steps: number) => void,
  getInterval: () => number,
): { sub: FrameSubscriber; handle: BoilHandle } {
  const sub: FrameSubscriber = { kind: 'frame', advance, getInterval, lastTick: 0, active: false };
  function start() {
    if (prmRef.value || sub.active) return;
    sub.active = true;
    sub.lastTick = 0;
    subscribers.add(sub);
    ensureScheduler();
  }
  return { sub, handle: { start, stop: () => withdraw(sub) } };
}

// ── useLineBoil — the frame-cycling composable ──

/**
 * Vue composable for frame cycling on the shared singleton rAF loop. Returns a
 * `currentFrame` ref that advances modulo `frameCount` every `intervalMs`.
 *
 * - Accepts number, Ref, or getter for frameCount + intervalMs.
 * - Pauses when the tab is hidden; resumes when visible (no elapsed-time jump).
 * - Respects prefers-reduced-motion reactively — a mid-session PRM flip tears the
 *   subscriber down centrally, not merely on the next enrolment.
 * - A static single frame (`frameCount <= 1`) NEVER subscribes; a `draw-then-boil`
 *   mark enrols the instant its count crosses 1 and withdraws if it drops back.
 */
export function useLineBoil(
  frameCount: MaybeRefOrGetter<number> = 4,
  intervalMs: MaybeRefOrGetter<number> = 125,
) {
  const currentFrame = ref(0);
  const { handle } = createSubscription(
    (steps) => {
      const total = normalizeFrameCount(toValue(frameCount));
      if (currentFrame.value >= total) currentFrame.value = 0;
      currentFrame.value = (currentFrame.value + steps) % total;
    },
    () => normalizeInterval(toValue(intervalMs)),
  );
  // `prmRef.value` is read unconditionally on every run (short-circuit `||` still evaluates
  // its left operand), so every subscriber's effect is subscribed to PRM changes regardless
  // of frame count — the gate owns the teardown branch, closing the M2 already-active gap.
  const stopWatch = watchEffect(() => {
    if (prmRef.value || normalizeFrameCount(toValue(frameCount)) <= 1) handle.stop();
    else handle.start();
  });
  onUnmounted(() => {
    stopWatch();
    handle.stop();
  });
  return { currentFrame, start: handle.start, stop: handle.stop };
}

// ── useRasterStack — baked pose cache, driven off the shared beat (0.9.0) ──
//
// The WebKit cure: instead of a resident filtered stack that re-rasters its feTurbulence +
// feDisplacementMap chain on every opacity flip (~150–224 ms board-area raster per beat in
// WebKit, ~2 cores at idle), capture each frozen pose ONCE (`raster.ts`) and opacity-swap
// the baked images on the beat — no filter re-executes at steady state, in either engine.
// This composable orchestrates the bake: it drives `pose` off the shared beat (through
// `useLineBoil`, so the same scheduler/PRM/visibility gates carry), captures each pose FRESH
// per bake (no cross-bake memo — a re-bake exists precisely because the pixels changed), and
// exposes `urls` (null until the bake resolves; render the live-filter fallback while null),
// `ready`, `pose`, and `rebake`.
//
// THE HANDLE IS URLs, NOT BITMAPS (0.11.0). What a surface renders is an `<image>` / `<img>`
// decoding an object URL; that decode is the single resident raster. Handing back an
// `ImageBitmap` made every consumer walk the same three extra steps to reach the URL —
// re-draw into a second surface, PNG-encode it, close the redundant bitmap — for a copy and
// an encode the capture had already paid for (79–195 ms + 87–112 ms per pose, ≈98% of a
// measured ~280 ms WebKit re-bake stall). The composable now mints the URLs itself and owns
// their lifetime: the previous set is revoked when the new one lands, a superseded bake
// revokes what it minted rather than leaking it, and unmount revokes the rest.
//
// RE-BAKE TRIGGERS (each changes the captured pixels, so the baked images go stale):
//   • DPR change — the window dragged between monitors; watched via a self-re-arming
//     `matchMedia('(resolution: Ndppx)')` at the live ratio.
//   • theme flip — light↔dark changes ink/line/fill colors; the consumer flips `cacheKey`
//     and the reactive-opts watch re-bakes (masked by the Bloom gesture at the toggle).
//   • `document.fonts.ready` — a `<text>` pose (logo Fraunces) must bake AFTER the face
//     loads, else the bake freezes the fallback glyphs; the first bake awaits it.
//   • cssSize change — the surface was re-laid-out, so the captured pixel box moved.
// While a (re-)bake is in flight `urls` is null — the consumer keeps the live-filter
// fallback mounted (one filtered raster per appearance, the sanctioned transient).
//
// THE SIZE-KEYED STACK CACHE (0.12.0). Through 0.11 this composable held exactly one baked
// stack and re-encoded on every trigger, on the stated reasoning that "a re-bake exists
// precisely because the pixels changed." That is true of DPR, theme and font — and false of
// the trigger that dominates in practice. A layout that TOGGLES between two boxes (a drawer
// opening and closing, a rail folding) walks a size the surface just baked, and the encode
// it pays is for pixels the composable had already produced and thrown away.
//
// The refutation is not "memoize anyway", it is that the old key was too narrow. The cache
// key is the FULL capture identity — `cacheKey` + dpr + `cssSize` + `poseCount` + whether
// the fonts had settled — so nothing the library knows can change under a live entry, and a
// hit is a hit on every input the capture reads. Re-entering a cached size performs ZERO
// encodes and hands back the SAME `Blob`s: byte-identical by object identity, not by
// tolerance. `poseCacheSize: 1` restores the 0.11 shape exactly (the previous stack is
// revoked as its successor lands), so the incumbent survives as a configuration rather than
// as a deleted branch.
//
// WHAT THE KEY CANNOT SEE, stated because it is the cache's one real hazard: `poseSvg` is a
// consumer callback entitled to read the live cascade, so a consumer that changes captured
// ink WITHOUT moving `cacheKey` will now be served its own stale bake instead of quietly
// re-encoding it. That was always the `cacheKey` contract ("MUST encode theme"); the cache
// makes breaking it visible. `rebake()` is the escape hatch and it FORCES — it drops the
// current key's entry before re-capturing, so "call for anything else" still means anything.
//
// WHY A CACHE AND NOT A THREAD (measured, pass-6 BC5-G4): the encode cannot be moved off the
// main thread from here. In WebKit `OffscreenCanvas.convertToBlob` called on the main thread
// blocks the main thread exactly as `HTMLCanvasElement.toBlob` does — 66–74 ms vs 62–77 ms
// for the same eight poses, against a 0 ms idle floor — so 0.11's move to `toBlob` forfeited
// no threading, and no rearrangement of the capture recovers any. Only a real Worker encodes
// off-thread (0 ms blocked), and a Worker cannot rasterize an SVG that resolves against the
// page's cascade. The encode a surface does not perform is the only encode that is free.
//
// Every bake yields one paint boundary (`nextPaint`) before it captures, so a `poseSvg` that
// resolves its ink off the live cascade reads the change that triggered the bake and not the
// state it replaced.

const BEAT_MS = 125; // the stop-motion beat useLineBoil defaults to — one clock, app-wide.

/**
 * Resident baked stacks per surface when `poseCacheSize` is unset. Four covers the shape the
 * cache exists for — a box that toggles between two values, across a theme flip — without
 * holding a history no layout will walk back through.
 */
const DEFAULT_POSE_CACHE = 4;

/**
 * One paint boundary: past the current flush cycle, then past a frame.
 *
 * `poseSvg` is a consumer callback and it is entitled to read the LIVE CASCADE
 * (`getComputedStyle(el).color`, a `--custom-property`) — that is how a themed bake gets its
 * ink. The re-bake that a theme flip triggers therefore must not capture until the flip is
 * readable. `nextTick` clears the flush that the key change belongs to, including the `post`
 * watchers a theme library writes its `<html>` class from; the frame clears anything scheduled
 * on a paint. The `setTimeout` races the rAF so a hidden tab — where rAF is parked — still bakes.
 */
function nextPaint(): Promise<void> {
  return nextTick().then(
    () =>
      new Promise<void>((resolve) => {
        const done = (): void => resolve();
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(done);
        setTimeout(done, 34);
      }),
  );
}

export interface RasterStackHandle {
  /**
   * Pose-indexed object URLs for the baked images — null until the bake resolves (render the
   * live-filter fallback while null). The composable owns their lifetime: never revoke these.
   */
  urls: Readonly<Ref<string[] | null>>;
  /** true once every pose has baked. */
  ready: Readonly<Ref<boolean>>;
  /** current pose index, advanced off the shared beat (`stepEveryBeats` forwarded). */
  pose: Readonly<Ref<number>>;
  /** force a re-bake — auto-fired on DPR / theme / font-ready change; call for anything else. */
  rebake: () => void;
}

/**
 * Vue composable for the baked pose cache. `opts` is a `RasterStackOptions` (reactive
 * ref/getter supported — a theme flip that changes `cacheKey`/`cssSize` re-bakes);
 * `stepEveryBeats` advances the pose once every N shared beats (default 1). See the block
 * comment above for the re-bake triggers. A single-pose stack never subscribes to the beat.
 */
export function useRasterStack(
  opts: MaybeRefOrGetter<RasterStackOptions>,
  stepEveryBeats: MaybeRefOrGetter<number> = 1,
): RasterStackHandle {
  const urls = ref<string[] | null>(null);
  const ready = computed(() => urls.value !== null);

  function revokeAll(handles: string[]): void {
    for (const handle of handles) URL.revokeObjectURL(handle);
  }

  /**
   * Baked stacks by capture identity, insertion-ordered (a `Map` iterates in insertion
   * order, so re-inserting on a hit IS the LRU touch). The cache OWNS every handle it holds:
   * a URL is revoked when its entry is evicted, dropped or the surface unmounts, and never
   * while it is resident — so a cached stack stays renderable for as long as it is reachable.
   */
  const stacks = new Map<string, string[]>();
  /** The key currently rendered — the one `rebake()` must drop to mean "force". */
  let liveKey: string | null = null;

  /** The full capture identity — every input the bake reads that the library can see. */
  function stackKey(o: RasterStackOptions, dpr: number): string {
    return `${o.cacheKey}|${dpr}|${o.cssSize.width}x${o.cssSize.height}|${o.poseCount}`;
  }

  /** Release every resident stack — the cache is the sole owner of what it holds. */
  function clearStacks(): void {
    for (const held of stacks.values()) revokeAll(held);
    stacks.clear();
    liveKey = null;
  }

  /** Insert, touch recency, and evict past the cap — revoking exactly what leaves. */
  function retain(key: string, minted: string[], cap: number): void {
    stacks.delete(key);
    stacks.set(key, minted);
    while (stacks.size > cap) {
      const oldest = stacks.keys().next().value as string;
      if (oldest === key) break; // never evict the entry just minted
      const evicted = stacks.get(oldest);
      stacks.delete(oldest);
      if (evicted) revokeAll(evicted);
    }
  }

  /** Drop one entry and release its handles. */
  function drop(key: string): void {
    const gone = stacks.get(key);
    if (!gone) return;
    stacks.delete(key);
    revokeAll(gone);
  }

  // pose rides the shared beat through useLineBoil — same scheduler, same PRM/visibility
  // gates. Interval = the beat × stepEveryBeats, so the pose advances every N beats aligned
  // to the app-wide grid. poseCount <= 1 never subscribes (useLineBoil's static-frame gate):
  // a single-pose stack holds pose 0, a static bitmap.
  const { currentFrame: pose } = useLineBoil(
    () => normalizeFrameCount(toValue(opts).poseCount),
    () => BEAT_MS * Math.max(1, Math.floor(toValue(stepEveryBeats) || 1)),
  );

  // A monotonic token supersedes a stale in-flight bake: if opts/DPR change mid-capture, the
  // older resolution must not clobber the newer bitmaps.
  let bakeToken = 0;

  async function bake(): Promise<void> {
    if (typeof document === 'undefined') return; // SSR / off-DOM — nothing to capture
    const o = toValue(opts);
    // A non-positive box means "not measured yet", not "capture a 1×1" (an <svg> has no
    // offsetWidth, so an element-size seed reads 0 before layout). Return BEFORE the token
    // bump: no in-flight bake is orphaned and no resolved bitmaps are nulled; the reactive
    // opts watch re-bakes the instant the box lands.
    if (!(o.cssSize.width > 0) || !(o.cssSize.height > 0)) return;
    const dprNow =
      o.dpr ?? (Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1);

    // THE HIT, taken before anything else costs anything. A resident stack was captured
    // under this exact identity, so re-encoding it could only reproduce it. Serve it whole
    // and synchronously: no token bump (nothing is in flight to supersede), no `urls = null`
    // (the surface never drops to its live-filter fallback), no paint boundary, no encode.
    // This is the entire cure for a layout returning to a box it just left.
    const hitKey = stackKey(o, dprNow);
    const hit = stacks.get(hitKey);
    if (hit) {
      bakeToken++; // orphan any bake still in flight — this stack supersedes it
      retain(hitKey, hit, Math.max(1, o.poseCacheSize ?? DEFAULT_POSE_CACHE));
      liveKey = hitKey;
      urls.value = hit;
      return;
    }

    const token = ++bakeToken;
    urls.value = null; // fall back to the live filter while the (re-)bake is in flight
    // Capture only once the change that TRIGGERED this bake is readable. A theme flip fires
    // this watch in the same flush that the theme library writes `<html class>` in, and
    // `poseSvg` resolves its ink off the cascade — capture synchronously and every pose bakes
    // the OLD theme's ink, then caches under the NEW key, where nothing invalidates it again.
    await nextPaint();
    if (token !== bakeToken) return; // superseded while yielding
    const dpr =
      o.dpr ?? (Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1);
    const captures: Promise<Blob>[] = [];
    for (let p = 0; p < o.poseCount; p++) {
      // Capture fresh, NOT through the shared boil LRU: a re-bake fires precisely because
      // the pixels changed (DPR, theme, font), so a memo would hand back exactly the stale
      // artifact the re-bake exists to replace.
      captures.push(rasterizePoseToBlob(o.poseSvg(p), o.cssSize, dpr));
    }
    try {
      const minted = (await Promise.all(captures)).map((blob) => URL.createObjectURL(blob));
      if (token !== bakeToken) {
        revokeAll(minted); // superseded while encoding — release what this bake minted
        return;
      }
      // Key on what was actually captured, not on what was current when the bake was
      // requested: DPR and font settling can both move across the paint boundary above.
      const key = stackKey(o, dpr);
      // The cap evicts the least recently served stack and revokes ONLY on eviction, so the
      // outgoing images stay valid for the frames between the swap and the browser's decode
      // of the new ones — 0.11's ordering property, now a consequence of the cap rather than
      // a hand-placed revoke. At `poseCacheSize: 1` the two are the same statement.
      retain(key, minted, Math.max(1, o.poseCacheSize ?? DEFAULT_POSE_CACHE));
      liveKey = key;
      urls.value = minted;
    } catch {
      // Leave urls null — the consumer keeps the live-filter fallback, and the previous set
      // stays live and revocable at unmount. A hard capture failure under a fixed key
      // persists, but the real re-bake triggers (DPR, theme) change the key, so a transient
      // failure does not wedge the surface.
    }
  }

  // FORCE, and it has to mean it: the cache would otherwise answer with the very artifact
  // the caller is asking to replace. Dropping the live key first turns the next bake into a
  // guaranteed miss, so "call for anything else" keeps the meaning it had before the cache.
  function rebake(): void {
    if (liveKey) drop(liveKey);
    void bake();
  }

  // First bake waits for the font face so a <text> pose bakes the real glyphs, not the
  // fallback; fonts.ready resolves immediately when nothing is pending. `bake()` is its own
  // SSR guard (it returns off-DOM), so this needs no mount hook — and not needing one is why
  // the composable now works inside a bare `effectScope` as well as inside a component.
  //
  // EVERY stack baked before the face landed is stale, not just the current one: the opts
  // watch can have raced a bake in at a size the layout has since left, and that stack would
  // sit in the cache holding fallback glyphs, waiting to be served the next time the layout
  // came back. So the font gate CLEARS the cache rather than keying around it — one line,
  // and it cannot leave a fallback-glyph stack anywhere.
  {
    const fontsReady =
      typeof document !== 'undefined' && document.fonts?.ready
        ? document.fonts.ready
        : Promise.resolve();
    void fontsReady.then(() => {
      clearStacks();
      return bake();
    });
  }

  // theme / cssSize / dpr change through the reactive opts → re-bake, keyed on the stable
  // capture inputs so an unrelated opts-identity change does not thrash the bake.
  const stopOptsWatch = watch(
    () => {
      const o = toValue(opts);
      return `${o.cacheKey}|${o.dpr ?? ''}|${o.cssSize.width}x${o.cssSize.height}|${o.poseCount}`;
    },
    () => void bake(),
  );

  // DPR change (monitor drag) → re-bake at the new ratio. matchMedia at the live dpr stops
  // matching when the ratio changes; the edge re-arms the query at the new ratio and re-bakes.
  let stopDprWatch: (() => void) | null = null;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    let mq: MediaQueryList | null = null;
    const onDprChange = (): void => {
      armDpr();
      void bake();
    };
    const armDpr = (): void => {
      if (mq) mq.removeEventListener('change', onDprChange);
      const dpr = window.devicePixelRatio || 1;
      mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
      mq.addEventListener('change', onDprChange);
    };
    armDpr();
    stopDprWatch = () => {
      if (mq) mq.removeEventListener('change', onDprChange);
    };
  }

  // Teardown rides the effect SCOPE, not the component. `onUnmounted` fires only inside a
  // component instance, so a composable driven in a bare `effectScope` — a headless proof, a
  // store, a renderless orchestrator — leaked every handle it ever minted and no gate could
  // see it. A component's `setup` runs inside a scope of its own, so `onScopeDispose` fires
  // on unmount exactly as `onUnmounted` did, and additionally where `onUnmounted` never did.
  onScopeDispose(() => {
    bakeToken++; // orphan any in-flight bake
    stopOptsWatch();
    stopDprWatch?.();
    // The cache is the sole owner, so draining it releases every handle the surface ever
    // minted — resident stacks and the live one alike. No handle outlives the surface.
    clearStacks();
    urls.value = null;
  }, true);

  return {
    urls: urls as Readonly<Ref<string[] | null>>,
    ready,
    pose: pose as Readonly<Ref<number>>,
    rebake,
  };
}

// ── createBoilTicker — imperative ping-pong frame ticker for glyph wiggle ──
//
// Created outside any component's synchronous setup() (glyph wiggle starts on a timer,
// well after mount), so it can't use onUnmounted()/watchEffect for its own lifecycle —
// callers own start()/stop() explicitly. Ping-pongs 0..frameCount-1..0 (an `alternate`
// traversal) rather than wrapping, preserving a back-and-forth wiggle character.

export function createBoilTicker(
  frameCount: number,
  intervalMs: number,
  onFrame: (frame: number) => void,
): BoilHandle {
  let idx = 0;
  let dir = 1;
  const { handle } = createSubscription(
    (steps) => {
      if (frameCount <= 1) return;
      for (let i = 0; i < steps; i++) {
        idx += dir;
        if (idx >= frameCount - 1) {
          idx = frameCount - 1;
          dir = -1;
        } else if (idx <= 0) {
          idx = 0;
          dir = 1;
        }
      }
      onFrame(idx);
    },
    () => normalizeInterval(intervalMs),
  );
  return handle;
}

// ── createSequenceSubscription — one-shot eased 0→1 tween on the shared chain ──
//
// The celebration's subscriber kind: a wall-clock tween that drives a continuous progress
// (stroke-dashoffset draw-in, a finite wiggle traversal, a specular sweep), then removes
// itself. NOT reactive and owns no watchEffect — callers create it imperatively (after
// mount, on an event) and hold start()/stop(). A completed tween self-unsubscribes inside
// the tick, so N concurrent draw-ins/flourishes still crest on exactly one rAF chain and
// the subscriber count falls back to the ambient floor after.

export interface SequenceHandle {
  start: () => void;
  /**
   * Withdraws the tween. NEVER throws, in any lifecycle phase — including mid-tween, from
   * inside `onProgress`, after `onComplete` has already self-unsubscribed it, and on a
   * handle that never started (the inert one PRM hands back).
   */
  stop: () => void;
}

export function createSequenceSubscription(opts: {
  durationMs: number;
  /** onset delay in ms — the tween stays idle (nothing drawn) until it elapses. */
  delayMs?: number;
  easing?: Easing;
  onProgress: (eased: number, raw: number) => void;
  onComplete?: () => void;
}): SequenceHandle {
  const sub: SequenceSubscriber = {
    kind: 'sequence',
    startTime: 0,
    durationMs: Math.max(1, opts.durationMs),
    easing: opts.easing ?? linear,
    onProgress: opts.onProgress,
    onComplete: opts.onComplete ?? (() => {}),
    active: false,
  };
  function start() {
    if (prmRef.value || sub.active) return;
    sub.active = true;
    // rAF timestamps share performance.now()'s time origin, so the tick can compare against
    // a start captured here (±one frame of skew, immaterial to a sub-second draw-in).
    sub.startTime = performance.now() + (opts.delayMs ?? 0);
    subscribers.add(sub);
    ensureScheduler();
  }
  return { start, stop: () => withdraw(sub) };
}

// ── createStrokeDrawIn — stroke-dashoffset draw-in on the shared chain ──
//
// The canonical `sequence` consumer: draw a path on as if by hand by tweening
// stroke-dashoffset from its full length down to 0. Sets the dash pattern up front, drives it
// via one `createSequenceSubscription`, and on completion clears the array outright
// (`strokeDasharray: 'none'`) so the settled stroke is solid even when `pathLength` is only
// approximate (the dash-gap-at-rest defect). Under PRM it paints the solid end state at once,
// fires `onComplete`, and returns an inert handle — never enrolling on the chain.
//
// `pathLength` defaults to the element's own `getTotalLength()` when omitted; pass it
// explicitly when the geometry's measured length is unreliable (hand-authored glyph paths).

export function createStrokeDrawIn(
  pathEl: SVGGeometryElement,
  opts: {
    pathLength?: number;
    durationMs?: number;
    delayMs?: number;
    easing?: Easing;
    onComplete?: () => void;
  } = {},
): SequenceHandle {
  const length =
    opts.pathLength ??
    (typeof pathEl.getTotalLength === 'function' ? pathEl.getTotalLength() : 0);

  const settle = () => {
    pathEl.style.strokeDasharray = 'none';
    pathEl.style.strokeDashoffset = '0';
  };

  if (prmRef.value) {
    settle();
    opts.onComplete?.();
    return { start: () => {}, stop: () => {} };
  }

  pathEl.style.strokeDasharray = String(length);
  pathEl.style.strokeDashoffset = String(length);

  return createSequenceSubscription({
    durationMs: opts.durationMs ?? 350,
    delayMs: opts.delayMs ?? 0,
    easing: opts.easing ?? easeOutCubic,
    onProgress: (eased) => {
      pathEl.style.strokeDashoffset = String(length * (1 - eased));
    },
    onComplete: () => {
      settle();
      opts.onComplete?.();
    },
  });
}

// ── instrumentation hook — reports the live chain/subscriber floor ──
//
// `chains` reads `rafId`, not `schedulerRunning`, so a hidden tab / PRM-engaged state
// truthfully reads 0 (no rAF outstanding) even while subscribers are retained — and so
// does a beat-PARKED steady state (asleep between beats), which reports `chains: 0,
// parked: true`. A settled boiling page samples as parked nearly always, with a
// one-frame `chains: 1` blip as each beat lands.

export function schedulerDebugInfo(): {
  chains: number;
  parked: boolean;
  subscribers: number;
  kinds: { frame: number; sequence: number };
} {
  let frame = 0;
  let sequence = 0;
  for (const sub of subscribers) {
    if (sub.kind === 'frame') frame++;
    else sequence++;
  }
  return {
    chains: rafId !== null ? 1 : 0,
    parked: beatTimer !== null,
    subscribers: subscribers.size,
    kinds: { frame, sequence },
  };
}
