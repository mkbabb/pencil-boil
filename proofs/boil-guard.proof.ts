/**
 * boil-guard.proof — the unified scheduler's behavioral invariants.
 *
 * pencil-boil ships TS source with no test runner; the in-repo gate is `tsc --noEmit`
 * plus this runnable, dependency-free assertion script. It runs headlessly on Node
 * (native TS stripping) by stubbing `window`/`requestAnimationFrame`/`matchMedia` and
 * driving the composables inside a Vue `effectScope` (so `watchEffect`/`onUnmounted`
 * resolve without a real component mount).
 *
 *   node proofs/boil-guard.proof.ts
 *
 * Proofs:
 *   (a) frameCount=1 mark mounts   => scheduler NEVER arms (zero rAF subscriptions).
 *   (b) frameCount=3 mark mounts   => arms; unmount => disarms (rAF stops re-arming).
 *   (c) prefers-reduced-motion on  => never arms, regardless of frameCount.
 *   (d) draw-then-boil: 1 -> 3 enrols after the draw; 3 -> 1 withdraws & disarms.
 *   (e) PRM flips true MID-SESSION => an already-active subscriber is torn down centrally
 *       (the M2 defect: a naive reactive fix guards new enrolment but never withdraws).
 *   (f) a `sequence` one-shot rides the same chain — starts it, completes on a late tick,
 *       self-unsubscribes, and the chain disarms.
 */

import { effectScope, nextTick, ref } from 'vue';

// ── A controllable rAF + matchMedia stub installed on a global `window` ──────

let rafArmCount = 0; // total requestAnimationFrame() calls (a proxy for "armed")
let cancelCount = 0; // total cancelAnimationFrame() calls
let pendingCb: ((t: number) => void) | null = null;
let nextRafId = 1;
let reduceMotion = false;

// The scheduler subscribes its matchMedia 'change' handler exactly ONCE at module load;
// this array persists across installEnv() calls so setReduceMotion() can reach it.
const prmChangeListeners: Array<(e: { matches: boolean }) => void> = [];

function installEnv(): void {
  rafArmCount = 0;
  cancelCount = 0;
  pendingCb = null;
  nextRafId = 1;

  const win = {
    requestAnimationFrame(cb: (t: number) => void): number {
      rafArmCount += 1;
      pendingCb = cb;
      return nextRafId++;
    },
    cancelAnimationFrame(_id: number): void {
      cancelCount += 1;
      pendingCb = null;
    },
    matchMedia(query: string) {
      return {
        matches: query.includes('reduce') ? reduceMotion : false,
        media: query,
        addEventListener(_type: string, cb: (e: { matches: boolean }) => void) {
          prmChangeListeners.push(cb);
        },
        removeEventListener() {},
      };
    },
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.requestAnimationFrame = win.requestAnimationFrame;
  g.cancelAnimationFrame = win.cancelAnimationFrame;
  g.matchMedia = win.matchMedia;
  // No `document` => the visibilitychange listener registration is skipped.
}

/** Flip prefers-reduced-motion and deliver a matchMedia 'change' to the scheduler. */
function setReduceMotion(v: boolean): void {
  reduceMotion = v;
  for (const l of prmChangeListeners) l({ matches: v });
}

/** Advance the stubbed rAF loop by one tick at the wall clock (re-arms via the scheduler). */
function pump(times = 1): void {
  for (let i = 0; i < times; i++) {
    const cb = pendingCb;
    pendingCb = null;
    if (cb) cb(performance.now());
  }
}

/** Advance the loop with an explicit timestamp (for driving a sequence tween to completion). */
function pumpAt(t: number): void {
  const cb = pendingCb;
  pendingCb = null;
  if (cb) cb(t);
}

/** Is the singleton scheduler currently armed (a frame is pending)? */
function armed(): boolean {
  return pendingCb !== null;
}

// ── Tiny assertion harness ───────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

// The composables register `onUnmounted`; headlessly they run inside an `effectScope`, so
// Vue warns there is no component instance. Teardown is driven explicitly, so silence it.
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('onUnmounted is called')) return;
    warn(...args);
  };
}

installEnv();
// Import AFTER the env is installed so the module's singleton sees the stub (and registers
// its matchMedia 'change' handler into prmChangeListeners).
const { useLineBoil, usePrefersReducedMotion, createSequenceSubscription, schedulerDebugInfo } =
  await import('../src/vue.ts');

// (a) A static single-frame mark NEVER arms the scheduler.
{
  installEnv();
  setReduceMotion(false);
  const scope = effectScope();
  scope.run(() => useLineBoil(1, 125));
  await nextTick();
  pump(3);
  assert(rafArmCount === 0, '(a) frameCount=1 mounts => rAF never armed (zero subscriptions)');
  assert(!armed(), '(a) frameCount=1 => scheduler not armed after pumps');
  scope.stop();
  await nextTick();
}

// (b) A boiling mark arms; unmount disarms and the rAF stops re-arming.
{
  installEnv();
  setReduceMotion(false);
  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | undefined;
  scope.run(() => {
    api = useLineBoil(3, 125);
  });
  await nextTick();
  assert(rafArmCount >= 1, '(b) frameCount=3 mounts => rAF armed (scheduler running)');
  assert(armed(), '(b) frameCount=3 => a frame is pending');
  pump(5);
  assert(armed(), '(b) frameCount=3 => scheduler re-arms across ticks');

  api!.stop();
  const cancelsBefore = cancelCount;
  pump(1);
  pump(1);
  assert(cancelCount >= cancelsBefore, '(b) unmount => cancelAnimationFrame fired (disarmed)');
  assert(!armed(), '(b) unmount => scheduler stops re-arming (zero subscribers => disarmed)');
  scope.stop();
  await nextTick();
}

// (c) prefers-reduced-motion is a second independent gate: never arms even at frameCount=3.
{
  installEnv();
  setReduceMotion(true);
  const scope = effectScope();
  scope.run(() => useLineBoil(3, 125));
  await nextTick();
  pump(3);
  assert(rafArmCount === 0, '(c) PRM=reduce + frameCount=3 => rAF never armed (independent gate)');
  assert(!armed(), '(c) PRM=reduce => scheduler not armed');
  assert(usePrefersReducedMotion().value === true, '(c) usePrefersReducedMotion() reflects the live state');
  scope.stop();
  await nextTick();
  setReduceMotion(false);
}

// (d) draw-then-boil: a reactive frameCount that flips 1 -> 3 enrols; 3 -> 1 withdraws.
{
  installEnv();
  setReduceMotion(false);
  const frames = ref(1);
  const scope = effectScope();
  scope.run(() => useLineBoil(frames, 125));
  await nextTick();
  pump(2);
  assert(rafArmCount === 0, '(d) starts at frameCount=1 => not armed during draw phase');

  frames.value = 3;
  await nextTick();
  assert(armed(), '(d) frameCount 1->3 => enrols & arms after the draw');

  frames.value = 1;
  await nextTick();
  const cancelsBefore = cancelCount;
  pump(1);
  pump(1);
  assert(cancelCount >= cancelsBefore, '(d) frameCount 3->1 => withdraws (cancelAnimationFrame fired)');
  assert(!armed(), '(d) frameCount 3->1 => scheduler disarms (no other subscribers)');
  scope.stop();
  await nextTick();
}

// (e) M2 — PRM flips true MID-SESSION tears down an already-active subscriber centrally.
{
  installEnv();
  setReduceMotion(false);
  const scope = effectScope();
  scope.run(() => useLineBoil(3, 125));
  await nextTick();
  assert(armed(), '(e) frameCount=3 arms before PRM engages');

  const cancelsBefore = cancelCount;
  setReduceMotion(true); // central force-clear reaches the active subscriber
  await nextTick();
  assert(cancelCount >= cancelsBefore, '(e) PRM engage mid-session => rAF cancelled');
  assert(!armed(), '(e) PRM engage mid-session => active subscriber torn down (not just gated)');
  assert(schedulerDebugInfo().subscribers === 0, '(e) PRM engage => subscribers force-cleared');
  scope.stop();
  await nextTick();
  setReduceMotion(false);
}

// (f) a `sequence` one-shot rides the same chain: starts, completes on a late tick, disarms.
{
  installEnv();
  setReduceMotion(false);
  let progressEnd = -1;
  let completed = false;
  const t0 = performance.now();
  const seq = createSequenceSubscription({
    durationMs: 50,
    onProgress: (eased) => {
      progressEnd = eased;
    },
    onComplete: () => {
      completed = true;
    },
  });
  seq.start();
  assert(armed(), '(f) sequence.start() arms the shared chain');
  assert(schedulerDebugInfo().kinds.sequence === 1, '(f) one sequence subscriber enrolled');

  pumpAt(t0 + 10_000); // a tick well past the 50ms duration => completion
  assert(progressEnd === 1, '(f) sequence completes with eased progress === 1');
  assert(completed, '(f) sequence fires onComplete');
  assert(!armed(), '(f) completed sequence self-unsubscribes => chain disarms');
  assert(schedulerDebugInfo().subscribers === 0, '(f) no subscribers remain after completion');
}

// ── Report ───────────────────────────────────────────────────────────────────

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;

console.log('');
if (failures.length === 0) {
  console.log(`boil-guard.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`boil-guard.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
