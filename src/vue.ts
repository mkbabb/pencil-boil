/**
 * Unified frame-index scheduler — one beat-aligned tick, app-wide, asleep between beats.
 *
 * Every boil consumer funnels into the SAME module-level `subscribers` Set and the
 * SAME single scheduler tick:
 *
 * - path-boil frame cycling — `useLineBoil` (aliased `useBoilFrame`): advance a
 *   discrete frame ref modulo a frame total every N ms.
 * - SVG filter `baseFrequency` (or any) per-tick side effect — `useFilterParamBoil`.
 * - imperative glyph wiggle — `createBoilTicker` (ping-pongs a frame index; created
 *   after mount, owns its own start/stop).
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
  onUnmounted,
  ref,
  toValue,
  watchEffect,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import { easeOutCubic, linear, type Easing } from './easings';

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
  // Sequence subscribers self-remove on completion; collect them and fire onComplete AFTER
  // the iteration so a chained flourish enrolled in a callback can't re-enter this same loop
  // (it ticks on the next frame instead).
  let completed: SequenceSubscriber[] | null = null;
  for (const sub of subscribers) {
    if (!sub.active) continue;
    if (sub.kind === 'frame') {
      const interval = sub.getInterval();
      if (sub.lastTick === 0) sub.lastTick = timestamp;
      const elapsed = timestamp - sub.lastTick;
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
  stop: () => void;
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
  function stop() {
    sub.active = false;
    subscribers.delete(sub);
    maybeStopScheduler();
  }
  return { sub, handle: { start, stop } };
}

// ── useLineBoil — the frame-cycling composable (aliased `useBoilFrame`) ──

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

/** Drop-in alias for {@link useLineBoil} — the name the sudoku consumer imports. */
export const useBoilFrame = useLineBoil;

// ── useFilterParamBoil — generic per-tick side effect (e.g. SVG filter baseFrequency) ──

/**
 * Run an arbitrary side effect every `intervalMs` on the shared chain. Unlike
 * {@link useLineBoil} it cycles no Vue-reactive ref — its `onTick(steps)` fires the
 * effect directly (deliberately bypassing reactivity for hot DOM writes). Gated on PRM
 * and tab visibility for free; owns its own teardown on unmount.
 */
export function useFilterParamBoil(
  onTick: (steps: number) => void,
  intervalMs: MaybeRefOrGetter<number> = 125,
): BoilHandle {
  const { handle } = createSubscription(onTick, () => normalizeInterval(toValue(intervalMs)));
  const stopWatch = watchEffect(() => {
    if (prmRef.value) handle.stop();
    else handle.start();
  });
  onUnmounted(() => {
    stopWatch();
    handle.stop();
  });
  return handle;
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
  function stop() {
    sub.active = false;
    subscribers.delete(sub);
    maybeStopScheduler();
  }
  return { start, stop };
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
