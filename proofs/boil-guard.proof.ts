/**
 * boil-guard.proof — the unified scheduler's behavioral invariants.
 *
 * pencil-boil ships TS source with no test runner; the in-repo gate is `tsc --noEmit`
 * plus this runnable, dependency-free assertion script. It runs headlessly on Node
 * (native TS stripping) by stubbing `window`/`requestAnimationFrame`/`setTimeout`/
 * `matchMedia` and driving the composables inside a Vue `effectScope` (so
 * `watchEffect`/`onUnmounted` resolve without a real component mount).
 *
 *   node proofs/boil-guard.proof.ts
 *
 * "Armed" spans BOTH wake shapes the 0.8.0 scheduler holds: a pending beat timer
 * (frame-only parking) or an outstanding rAF (a beat landing / a live sequence).
 *
 * Proofs:
 *   (a) frameCount=1 mark mounts   => scheduler NEVER arms (no timer, no rAF).
 *   (b) frameCount=3 mark mounts   => arms; unmount => disarms (stops re-arming).
 *   (c) prefers-reduced-motion on  => never arms, regardless of frameCount.
 *   (d) draw-then-boil: 1 -> 3 enrols after the draw; 3 -> 1 withdraws & disarms.
 *   (e) PRM flips true MID-SESSION => an already-active subscriber is torn down centrally
 *       (the M2 defect: a naive reactive fix guards new enrolment but never withdraws).
 *   (f) a `sequence` one-shot rides the continuous rAF chain — starts it, completes on a
 *       late tick, self-unsubscribes, and the scheduler disarms.
 *   (g) the sleeping steady state — a frame-only page parks on the beat timer with NO rAF
 *       outstanding, lands exactly ONE rAF per beat, re-parks after each tick; a live
 *       sequence supersedes the park with the continuous chain and completion falls back
 *       to parking (the T3-W13 P1 contract: the settled page's vsync heartbeat is dead).
 */

import { effectScope, nextTick, ref } from 'vue';

// ── A controllable rAF + setTimeout + matchMedia stub installed globally ─────

let rafArmCount = 0; // total requestAnimationFrame() calls
let cancelCount = 0; // total cancelAnimationFrame() calls
let timerArmCount = 0; // total setTimeout() calls (the beat park)
let timerCancelCount = 0; // total clearTimeout() calls of a pending timer
let pendingCb: ((t: number) => void) | null = null;
const pendingTimers = new Map<number, () => void>();
let nextRafId = 1;
let nextTimerId = 1;
let reduceMotion = false;

// The scheduler subscribes its matchMedia 'change' handler exactly ONCE at module load;
// this array persists across installEnv() calls so setReduceMotion() can reach it.
const prmChangeListeners: Array<(e: { matches: boolean }) => void> = [];

function installEnv(): void {
  rafArmCount = 0;
  cancelCount = 0;
  timerArmCount = 0;
  timerCancelCount = 0;
  pendingCb = null;
  pendingTimers.clear();
  nextRafId = 1;
  nextTimerId = 1;

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
    setTimeout(cb: () => void, _delay?: number): number {
      timerArmCount += 1;
      const id = nextTimerId++;
      pendingTimers.set(id, cb);
      return id;
    },
    clearTimeout(id: number): void {
      if (pendingTimers.delete(id)) timerCancelCount += 1;
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
  // The scheduler's beat park calls bare `setTimeout`/`clearTimeout`, which resolve to
  // globalThis at call time — safe to stub here: nothing else in the proof's own flow
  // (Vue's nextTick is microtask-based) schedules macrotask timers.
  g.setTimeout = win.setTimeout;
  g.clearTimeout = win.clearTimeout;
  g.matchMedia = win.matchMedia;
  // No `document` => the visibilitychange listener registration is skipped.
}

/** Flip prefers-reduced-motion and deliver a matchMedia 'change' to the scheduler. */
function setReduceMotion(v: boolean): void {
  reduceMotion = v;
  for (const l of prmChangeListeners) l({ matches: v });
}

/** Fire every pending beat timer (the wake arms the scheduler's ONE landing rAF). */
function fireTimers(): void {
  for (const [id, cb] of [...pendingTimers]) {
    pendingTimers.delete(id);
    cb();
  }
}

/** Fire the pending rAF callback, if any, at an explicit timestamp. */
function fireRaf(t = performance.now()): void {
  const cb = pendingCb;
  pendingCb = null;
  if (cb) cb(t);
}

/** Advance one full scheduler cycle: land any pending beat wake, then tick its rAF. */
function pump(times = 1): void {
  for (let i = 0; i < times; i++) {
    fireTimers();
    fireRaf();
  }
}

/** Tick the pending rAF with an explicit timestamp (drives a sequence tween to completion). */
function pumpAt(t: number): void {
  fireRaf(t);
}

/** Is the singleton scheduler currently armed (a beat timer OR a rAF is pending)? */
function armed(): boolean {
  return pendingCb !== null || pendingTimers.size > 0;
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
  assert(rafArmCount === 0 && timerArmCount === 0, '(a) frameCount=1 mounts => neither timer nor rAF ever armed');
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
  assert(timerArmCount >= 1, '(b) frameCount=3 mounts => scheduler armed (parked on the beat timer)');
  assert(armed(), '(b) frameCount=3 => a wake is pending');
  pump(5);
  assert(armed(), '(b) frameCount=3 => scheduler re-arms across ticks');

  const timerCancelsBefore = timerCancelCount;
  api!.stop();
  pump(1);
  pump(1);
  assert(timerCancelCount > timerCancelsBefore, '(b) unmount => pending beat wake cancelled (disarmed)');
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
  assert(rafArmCount === 0 && timerArmCount === 0, '(c) PRM=reduce + frameCount=3 => never armed (independent gate)');
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
  assert(rafArmCount === 0 && timerArmCount === 0, '(d) starts at frameCount=1 => not armed during draw phase');

  frames.value = 3;
  await nextTick();
  assert(armed(), '(d) frameCount 1->3 => enrols & arms after the draw');

  const timerCancelsBefore = timerCancelCount;
  frames.value = 1;
  await nextTick();
  pump(1);
  pump(1);
  assert(timerCancelCount > timerCancelsBefore, '(d) frameCount 3->1 => withdraws (pending wake cancelled)');
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

  const timerCancelsBefore = timerCancelCount;
  setReduceMotion(true); // central force-clear reaches the active subscriber
  await nextTick();
  assert(timerCancelCount > timerCancelsBefore, '(e) PRM engage mid-session => pending wake cancelled');
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
  assert(pendingCb !== null, '(f) sequence.start() arms the continuous rAF chain (not the beat park)');
  assert(schedulerDebugInfo().kinds.sequence === 1, '(f) one sequence subscriber enrolled');

  pumpAt(t0 + 10_000); // a tick well past the 50ms duration => completion
  assert(progressEnd === 1, '(f) sequence completes with eased progress === 1');
  assert(completed, '(f) sequence fires onComplete');
  assert(!armed(), '(f) completed sequence self-unsubscribes => chain disarms');
  assert(schedulerDebugInfo().subscribers === 0, '(f) no subscribers remain after completion');
}

// (g) The sleeping steady state — the T3-W13 P1 contract. A frame-only page holds NO
// outstanding rAF between beats: it parks on ONE beat timer, lands exactly ONE rAF per
// wake, and re-parks after the tick. A live sequence supersedes the park with the
// continuous chain; its completion falls back to parking.
{
  installEnv();
  setReduceMotion(false);
  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | undefined;
  scope.run(() => {
    api = useLineBoil(4, 125);
  });
  await nextTick();

  assert(rafArmCount === 0, '(g) enrol parks on the beat timer — NO rAF armed at rest');
  assert(pendingTimers.size === 1, '(g) exactly one beat wake pending');
  assert(schedulerDebugInfo().parked && schedulerDebugInfo().chains === 0, '(g) debug reads parked, chains=0 (asleep)');

  fireTimers(); // the wake
  assert(rafArmCount === 1 && pendingCb !== null, '(g) the wake lands exactly ONE rAF');
  assert(pendingTimers.size === 0, '(g) no timer pending while the landing rAF is in flight');

  fireRaf();
  assert(pendingCb === null, '(g) the tick consumes its rAF — the chain does not respin on vsync');
  assert(pendingTimers.size === 1, '(g) the tick re-parks on the next beat boundary');

  const rafsBefore = rafArmCount;
  pump(3);
  assert(rafArmCount === rafsBefore + 3, '(g) exactly one rAF per beat across cycles (no extra frames)');
  assert(pendingTimers.size === 1 && pendingCb === null, '(g) steady state is timer-parked after every cycle');

  // A live sequence supersedes the park: continuous chain while it runs, park after.
  const seq = createSequenceSubscription({ durationMs: 50, onProgress: () => {} });
  seq.start();
  assert(pendingCb !== null && pendingTimers.size === 0, '(g) a live sequence supersedes the park — continuous chain');
  fireRaf();
  assert(pendingCb !== null, '(g) the chain stays continuous while the sequence runs');
  pumpAt(performance.now() + 10_000); // completes the sequence; the frame subscriber remains
  assert(pendingCb === null && pendingTimers.size === 1, '(g) sequence completion falls back to beat parking');

  api!.stop();
  scope.stop();
  await nextTick();
  assert(!armed(), '(g) withdrawal disarms both wake shapes');
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
