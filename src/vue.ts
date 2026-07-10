/**
 * Unified frame-index scheduler — one rAF chain, app-wide.
 *
 * Every boil consumer funnels into the SAME module-level `subscribers` Set and the
 * SAME single `requestAnimationFrame` chain:
 *
 * - path-boil frame cycling — `useLineBoil` (aliased `useBoilFrame`): advance a
 *   discrete frame ref modulo a frame total every N ms.
 * - SVG filter `baseFrequency` (or any) per-tick side effect — `useFilterParamBoil`.
 * - imperative glyph wiggle — `createBoilTicker` (ping-pongs a frame index; created
 *   after mount, owns its own start/stop).
 * - one-shot eased draw-ins / flourishes — `createSequenceSubscription` (the
 *   `sequence` kind: a wall-clock tween that self-unsubscribes on completion).
 *
 * However many things want to advance on a clock, there is exactly one rAF callback
 * doing the advancing.
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
 * 2. Tab visibility — cancels the rAF on `hidden` (0 ticks), resets every active frame
 *    subscriber's `lastTick` on `visible`, then resumes the one chain ONLY if a
 *    subscriber is still active (a page of zero subscribers never resumes an empty
 *    idle loop).
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
let schedulerRunning = false;

// ── single-chain invariant ──
// `startChain`/`stopChain` are the ONLY places a rAF handle is created or cancelled
// outside `schedulerTick`'s own tail, and `startChain` is idempotent on `rafId`. Every
// path (enrol, visibility resume, PRM) funnels through them, so there is provably at most
// one outstanding `schedulerTick` at any instant — a resume that races the browser's frame
// commit can never spawn a second, untracked loop.

function startChain() {
  if (rafId !== null || typeof requestAnimationFrame === 'undefined') return;
  rafId = requestAnimationFrame(schedulerTick);
}

function stopChain() {
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
  // A finished sequence may have been the last active subscriber — shut the chain down so a
  // settled page returns to the ambient floor rather than spinning empty.
  maybeStopScheduler();
  // Continue the one chain only while running — a tick that fires after a cancel (PRM
  // engage / tab hidden raced the browser's frame commit) must not resurrect it.
  rafId = schedulerRunning ? requestAnimationFrame(schedulerTick) : null;
}

function ensureScheduler() {
  schedulerRunning = true;
  startChain();
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
      stopChain(); // 0 ticks; schedulerRunning is left intact for resume
    } else if (schedulerRunning && hasActiveSubscriber()) {
      // Resume ONLY with a live subscriber — a page whose marks all withdrew while hidden
      // (or never enrolled) must not resume an empty idle rAF loop. Frame subscribers reset
      // their wall-clock anchor so an elapsed-time jump can't fast-forward every frame index
      // at once. Sequence one-shots have no `lastTick`: a tween that would have finished
      // while hidden completes on the first resumed tick — the correct end state.
      for (const sub of subscribers) if (sub.kind === 'frame') sub.lastTick = 0;
      startChain(); // idempotent — resume can never double the chain
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
// truthfully reads 0 (no rAF outstanding) even while subscribers are retained.

export function schedulerDebugInfo(): {
  chains: number;
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
    subscribers: subscribers.size,
    kinds: { frame, sequence },
  };
}
