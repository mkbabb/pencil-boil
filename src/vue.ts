import {
  onUnmounted,
  ref,
  toValue,
  watchEffect,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';

function normalizeFrameCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value)) return 125;
  return Math.max(16, Math.floor(value));
}

interface Subscriber {
  currentFrame: Ref<number>;
  getFrameCount: () => number;
  getInterval: () => number;
  lastTick: number;
  active: boolean;
}

// ── Singleton RAF scheduler ──────────────────────────────────────────

const subscribers = new Set<Subscriber>();
let rafId: number | null = null;
let schedulerRunning = false;

function schedulerTick(timestamp: number) {
  if (!schedulerRunning) return;

  for (const sub of subscribers) {
    if (!sub.active) continue;

    const frameTotal = sub.getFrameCount();
    const interval = sub.getInterval();
    if (sub.currentFrame.value >= frameTotal) sub.currentFrame.value = 0;

    if (sub.lastTick === 0) sub.lastTick = timestamp;

    const elapsed = timestamp - sub.lastTick;
    if (elapsed >= interval) {
      const steps = Math.floor(elapsed / interval);
      sub.lastTick += steps * interval;
      sub.currentFrame.value = (sub.currentFrame.value + steps) % frameTotal;
    }
  }

  rafId = requestAnimationFrame(schedulerTick);
}

function ensureScheduler() {
  if (schedulerRunning || typeof window === 'undefined') return;
  schedulerRunning = true;
  rafId = requestAnimationFrame(schedulerTick);
}

function maybeStopScheduler() {
  let anyActive = false;
  for (const sub of subscribers) {
    if (sub.active) { anyActive = true; break; }
  }
  if (!anyActive && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    schedulerRunning = false;
  }
}

// Pause/resume on tab visibility
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        schedulerRunning = false;
      }
    } else {
      // Reset lastTick so elapsed doesn't jump
      for (const sub of subscribers) {
        if (sub.active) sub.lastTick = 0;
      }
      ensureScheduler();
    }
  });
}

// ── Composable ───────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Vue composable for frame cycling with a shared singleton RAF loop.
 * All consumers tick on the same requestAnimationFrame callback,
 * eliminating per-instance RAF overhead.
 *
 * - Supports number, Ref, or getter for frameCount + intervalMs.
 * - Pauses when tab is hidden; resumes when visible.
 * - Respects prefers-reduced-motion.
 */
export function useLineBoil(
  frameCount: MaybeRefOrGetter<number> = 4,
  intervalMs: MaybeRefOrGetter<number> = 125,
) {
  const currentFrame = ref(0);

  const sub: Subscriber = {
    currentFrame,
    getFrameCount: () => normalizeFrameCount(toValue(frameCount)),
    getInterval: () => normalizeInterval(toValue(intervalMs)),
    lastTick: 0,
    active: false,
  };

  function start() {
    // Two independent gates: a reduced-motion preference, and a static frame.
    // A single static frame (frameCount <= 1) animates nothing, so it must NEVER
    // subscribe to the singleton scheduler — the boil loop's existence is derived
    // from whether any mark actually cycles frames, never a side effect of mounting.
    if (prefersReducedMotion()) return;
    if (sub.getFrameCount() <= 1) return;
    if (sub.active) return;
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

  // Enrol/withdraw reactively from the live frame count: a `draw-on` mark
  // (frameCount === 1) never enrols; a `draw-then-boil` mark enrols the instant
  // its count crosses 1 after the draw completes; a mark that drops back to a
  // single frame withdraws and lets the scheduler disarm.
  const stopWatch = watchEffect(() => {
    if (sub.getFrameCount() > 1) start();
    else stop();
  });

  onUnmounted(() => {
    stopWatch();
    stop();
  });

  return { currentFrame, start, stop };
}
