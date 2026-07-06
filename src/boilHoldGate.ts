/**
 * Boil-hold gate — a freeze contract for the shared scheduler.
 *
 * A hold pauses frame-boil subscribers IN PLACE — the frame ref simply stops
 * advancing, with no snap to frame 0.
 *
 * Mechanism: `heldFrameCount()` wraps a frame-count getter so it collapses to 1
 * while any hold is active. The unified scheduler withdraws a subscriber whose
 * count drops to <= 1 — `useLineBoil`'s `watchEffect` calls `stop()`, and `stop()`
 * leaves `currentFrame` untouched — so the mark freezes on its current frame. On
 * release the count returns to its real value, the subscriber re-enrols with
 * `lastTick = 0`, and the boil resumes mid-cadence.
 *
 * Introduces NO second rAF chain: it rides the scheduler by construction, gating a
 * frame-count getter alongside PRM + visibility.
 */
import { computed, ref, type ComputedRef } from 'vue';

const holds = ref<Set<string>>(new Set());

/** True while any hold is active — a boil consumer gates its cadence on this. */
export const isBoilHeld: ComputedRef<boolean> = computed(() => holds.value.size > 0);

export function acquireHold(reason: string): void {
  if (holds.value.has(reason)) return;
  const next = new Set(holds.value);
  next.add(reason);
  holds.value = next;
}

export function releaseHold(reason: string): void {
  if (!holds.value.has(reason)) return;
  const next = new Set(holds.value);
  next.delete(reason);
  holds.value = next;
}

/**
 * Wrap a frame-count getter so it collapses to 1 (a static frame) while held.
 * A boil consumer passes `heldFrameCount(() => frameCount)` to `useLineBoil`; the
 * getter reactively returns 1 during a hold, tripping the scheduler's
 * `frameCount <= 1` stop path, then returns to its real value on release. No second
 * chain — the same scheduler, one gate more.
 */
export function heldFrameCount(base: () => number): () => number {
  return () => (isBoilHeld.value ? 1 : base());
}
