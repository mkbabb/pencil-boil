import { onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter } from 'vue';

function normalizeFrameCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value)) return 125;
  return Math.max(16, Math.floor(value));
}

/**
 * Vue composable for frame cycling.
 * - Uses requestAnimationFrame for smooth cadence.
 * - Supports number, Ref, or getter for frameCount + intervalMs.
 * - Pauses when tab is hidden; resumes when visible.
 * - Respects prefers-reduced-motion.
 */
export function useLineBoil(
  frameCount: MaybeRefOrGetter<number> = 4,
  intervalMs: MaybeRefOrGetter<number> = 125,
) {
  const currentFrame = ref(0);

  let rafId: number | null = null;
  let running = false;
  let shouldRun = false;
  let lastTick = 0;

  const getFrameCount = () => normalizeFrameCount(toValue(frameCount));
  const getInterval = () => normalizeInterval(toValue(intervalMs));

  function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function haltLoop() {
    if (rafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    running = false;
    lastTick = 0;
  }

  function tick(timestamp: number) {
    if (!running || typeof window === 'undefined') return;

    const frameTotal = getFrameCount();
    const interval = getInterval();
    if (currentFrame.value >= frameTotal) currentFrame.value = 0;

    if (lastTick === 0) lastTick = timestamp;

    const elapsed = timestamp - lastTick;
    if (elapsed >= interval) {
      const steps = Math.floor(elapsed / interval);
      lastTick += steps * interval;
      currentFrame.value = (currentFrame.value + steps) % frameTotal;
    }

    rafId = window.requestAnimationFrame(tick);
  }

  function beginLoop() {
    if (running || typeof window === 'undefined' || prefersReducedMotion()) return;
    running = true;
    lastTick = 0;
    rafId = window.requestAnimationFrame(tick);
  }

  function start() {
    shouldRun = true;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    beginLoop();
  }

  function stop() {
    shouldRun = false;
    haltLoop();
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      haltLoop();
      return;
    }
    if (shouldRun) beginLoop();
  }

  onMounted(() => {
    start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
  });

  onUnmounted(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    haltLoop();
  });

  return { currentFrame, start, stop };
}

