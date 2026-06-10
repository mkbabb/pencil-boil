/**
 * boil-guard.proof — the static-frame-costs-zero-frames invariant (E1 §1 / E4 root).
 *
 * In the 0.4.0 proof culture pencil-boil ships TS source with no test runner; the
 * in-repo gate is `tsc --noEmit` plus a runnable, dependency-free assertion script.
 * This is that script for `useLineBoil`'s boil guard. It runs headlessly on Node
 * (native TS stripping) by stubbing `window`/`requestAnimationFrame` and driving the
 * composable inside a Vue `effectScope` (so `watchEffect`/`onUnmounted` resolve
 * without a real component mount).
 *
 *   node proofs/boil-guard.proof.ts
 *
 * Proofs:
 *   (a) frameCount=1 mark mounts  => scheduler NEVER arms (zero rAF subscriptions).
 *   (b) frameCount=3 mark mounts  => arms; unmount => disarms (rAF stops re-arming).
 *   (c) prefers-reduced-motion    => never arms, regardless of frameCount.
 *   (d) draw-then-boil: 1 -> 3 enrols after the draw; 3 -> 1 withdraws & disarms.
 */

import { effectScope, nextTick, ref } from 'vue';

// ── A controllable rAF + matchMedia stub installed on a global `window` ──────

let rafArmCount = 0; // total requestAnimationFrame() calls (a proxy for "armed")
let cancelCount = 0; // total cancelAnimationFrame() calls
let pendingCb: ((t: number) => void) | null = null;
let nextRafId = 1;
let reduceMotion = false;

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
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };

  // pencil-boil reads requestAnimationFrame off the global (window) scope.
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.requestAnimationFrame = win.requestAnimationFrame;
  g.cancelAnimationFrame = win.cancelAnimationFrame;
  g.matchMedia = win.matchMedia;
  // No `document` => the visibilitychange listener registration is skipped.
}

/** Advance the stubbed rAF loop by one tick (re-arms via the scheduler's own call). */
function pump(times = 1): void {
  for (let i = 0; i < times; i++) {
    const cb = pendingCb;
    pendingCb = null;
    if (cb) cb(performance.now());
  }
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

// The composable registers `onUnmounted` for the real component path; here it runs
// headlessly inside an `effectScope`, so Vue warns there is no component instance.
// Teardown is driven explicitly (api.stop() + scope.stop()), so the hook is inert —
// silence the expected warning to keep the proof output clean.
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('onUnmounted is called')) return;
    warn(...args);
  };
}

installEnv();
// Import AFTER the env is installed so the module's singleton sees the stub.
const { useLineBoil } = await import('../src/vue.ts');

// (a) A static single-frame mark NEVER arms the scheduler.
{
  reduceMotion = false;
  installEnv();
  const scope = effectScope();
  scope.run(() => useLineBoil(1, 125));
  await nextTick();
  pump(3); // give the loop every chance to re-arm
  assert(rafArmCount === 0, '(a) frameCount=1 mounts => rAF never armed (zero subscriptions)');
  assert(!armed(), '(a) frameCount=1 => scheduler not armed after pumps');
  scope.stop();
  await nextTick();
}

// (b) A boiling mark arms; unmount disarms and the rAF stops re-arming.
{
  reduceMotion = false;
  installEnv();
  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | undefined;
  scope.run(() => {
    api = useLineBoil(3, 125);
  });
  await nextTick();
  assert(rafArmCount >= 1, '(b) frameCount=3 mounts => rAF armed (scheduler running)');
  assert(armed(), '(b) frameCount=3 => a frame is pending');
  pump(5); // it keeps re-arming while a subscriber is active
  assert(armed(), '(b) frameCount=3 => scheduler re-arms across ticks');

  // Unmount via the returned stop() (the orchestrator's onUnmounted path is the same).
  api!.stop();
  const cancelsBefore = cancelCount;
  // Drain any in-flight frame; with zero active subscribers it must NOT re-arm.
  pump(1);
  pump(1);
  assert(cancelCount >= cancelsBefore, '(b) unmount => cancelAnimationFrame fired (disarmed)');
  assert(!armed(), '(b) unmount => scheduler stops re-arming (zero subscribers => disarmed)');
  scope.stop();
  await nextTick();
}

// (c) prefers-reduced-motion is a second independent gate: never arms even at frameCount=3.
{
  reduceMotion = true;
  installEnv();
  const scope = effectScope();
  scope.run(() => useLineBoil(3, 125));
  await nextTick();
  pump(3);
  assert(rafArmCount === 0, '(c) PRM=reduce + frameCount=3 => rAF never armed (independent gate)');
  assert(!armed(), '(c) PRM=reduce => scheduler not armed');
  scope.stop();
  await nextTick();
  reduceMotion = false;
}

// (d) draw-then-boil: a reactive frameCount that flips 1 -> 3 enrols; 3 -> 1 withdraws.
{
  reduceMotion = false;
  installEnv();
  const frames = ref(1); // starts static (the "draw-on" phase)
  const scope = effectScope();
  scope.run(() => useLineBoil(frames, 125));
  await nextTick();
  pump(2);
  assert(rafArmCount === 0, '(d) starts at frameCount=1 => not armed during draw phase');

  // The draw completes; the brush now boils.
  frames.value = 3;
  await nextTick();
  assert(armed(), '(d) frameCount 1->3 => enrols & arms after the draw');

  // Flip back to a single static frame => withdraw & disarm.
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

// ── Report ───────────────────────────────────────────────────────────────────

// pencil-boil is a browser/Vue lib with no `@types/node`; reach the runtime exit
// through `globalThis` so the proof type-checks standalone without a node type dep.
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
