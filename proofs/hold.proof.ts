/**
 * hold.proof — the boilHoldGate freeze contract, previously consumed-but-unproven.
 *
 *   node --import ./proofs/loader.mjs proofs/hold.proof.ts
 *
 * `heldFrameCount` / `acquireHold` / `releaseHold` / `isBoilHeld` are consumed in the app
 * (HandDrawnGrid, BoilDivider, AnswerKeyLaminate) with zero proof of the contract: a hold
 * collapses a frame-count getter to 1, the unified scheduler withdraws the subscriber whose
 * count drops to <= 1, the mark freezes ON ITS CURRENT FRAME (no snap to 0), and release
 * restores the count and re-enrols mid-cadence. Runs in the SAME node/effectScope + stubbed
 * scheduler harness as boil-guard.proof.
 *
 * Proofs:
 *   (a) COLLAPSE + REF-COUNT: heldFrameCount(()=>4)() is 4 unheld, 1 while ANY hold is
 *       active; isBoilHeld tracks a set of reasons (dedup on repeat, held until the LAST
 *       release).
 *   (b) FREEZE-IN-PLACE: acquire withdraws the boil subscriber (count -> 1 trips useLineBoil's
 *       static-frame stop), disarms the scheduler, and leaves currentFrame UNCHANGED — no
 *       snap to frame 0.
 *   (c) RE-ENROL MID-CADENCE: release restores the count, re-enrols the subscriber (re-arms),
 *       and currentFrame still holds the frozen value (resumes where it stopped).
 */

import { effectScope, nextTick } from 'vue';

// ── the boil-guard env stub: rAF + setTimeout + matchMedia, globally installed ──

let rafArmCount = 0;
let timerArmCount = 0;
let timerCancelCount = 0;
let pendingCb: ((t: number) => void) | null = null;
const pendingTimers = new Map<number, () => void>();
let nextRafId = 1;
let nextTimerId = 1;
let reduceMotion = false;
const prmChangeListeners: Array<(e: { matches: boolean }) => void> = [];

function installEnv(): void {
  rafArmCount = 0;
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
  g.setTimeout = win.setTimeout;
  g.clearTimeout = win.clearTimeout;
  g.matchMedia = win.matchMedia;
  // No `document` => the visibilitychange listener registration is skipped.
}

function setReduceMotion(v: boolean): void {
  reduceMotion = v;
  for (const l of prmChangeListeners) l({ matches: v });
}

function fireTimers(): void {
  for (const [id, cb] of [...pendingTimers]) {
    pendingTimers.delete(id);
    cb();
  }
}

function fireRaf(t = performance.now()): void {
  const cb = pendingCb;
  pendingCb = null;
  if (cb) cb(t);
}

function pump(times = 1): void {
  for (let i = 0; i < times; i++) {
    fireTimers();
    fireRaf();
  }
}

function armed(): boolean {
  return pendingCb !== null || pendingTimers.size > 0;
}

// ── assertion harness ──

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

// Silence Vue's "onUnmounted called without active component" (composables run headlessly
// inside an effectScope; teardown is driven explicitly).
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('onUnmounted is called')) return;
    warn(...args);
  };
}

installEnv();
// Import AFTER the env is installed so the scheduler singleton sees the stub.
const { useLineBoil, schedulerDebugInfo } = await import('../src/vue.ts');
const { isBoilHeld, acquireHold, releaseHold, heldFrameCount } = await import(
  '../src/boilHoldGate.ts'
);

// (a) COLLAPSE + REF-COUNT — the pure gate, no scheduler.
{
  const count = heldFrameCount(() => 4);
  assert(!isBoilHeld.value, '(a) no hold at rest');
  assert(count() === 4, '(a) heldFrameCount passes the base value through when unheld');

  acquireHold('peek');
  assert(isBoilHeld.value, '(a) acquireHold engages isBoilHeld');
  assert(count() === 1, '(a) heldFrameCount collapses to 1 while held');

  acquireHold('peek'); // idempotent — a repeated reason does not stack
  releaseHold('peek');
  assert(!isBoilHeld.value, '(a) a repeated reason deduped — one release clears it');
  assert(count() === 4, '(a) heldFrameCount returns to the base value on release');

  acquireHold('a');
  acquireHold('b');
  releaseHold('a');
  assert(isBoilHeld.value, '(a) still held while another reason is outstanding');
  releaseHold('b');
  assert(!isBoilHeld.value, '(a) released only after the LAST reason clears');
}

// (b) FREEZE-IN-PLACE and (c) RE-ENROL MID-CADENCE — the scheduler contract.
{
  installEnv();
  setReduceMotion(false);
  // holds is empty from (a); assert it so the subscriber actually arms.
  assert(!isBoilHeld.value, '(b) holds cleared before the freeze test');

  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | undefined;
  scope.run(() => {
    api = useLineBoil(heldFrameCount(() => 4), 125);
  });
  await nextTick();
  assert(armed(), '(b) frameCount=4 mounts => scheduler armed (parked on the beat timer)');
  assert(schedulerDebugInfo().subscribers === 1, '(b) one boil subscriber enrolled');

  // Simulate a mid-cadence frame — the freeze must hold THIS value, not snap to 0.
  api!.currentFrame.value = 2;

  const cancelsBefore = timerCancelCount;
  acquireHold('peek');
  await nextTick();
  assert(!armed(), '(b) acquire => count->1 withdraws the subscriber, scheduler disarms');
  assert(timerCancelCount > cancelsBefore, '(b) the pending beat wake is cancelled on hold');
  assert(schedulerDebugInfo().subscribers === 0, '(b) no boil subscriber remains while held');
  assert(api!.currentFrame.value === 2, '(b) FREEZE IN PLACE — currentFrame unchanged (no snap to 0)');

  pump(2);
  assert(api!.currentFrame.value === 2, '(b) a held mark does not advance across beats');

  // (c) release — restore the count, re-enrol, resume mid-cadence.
  releaseHold('peek');
  await nextTick();
  assert(armed(), '(c) release => count->4 re-enrols the subscriber (re-armed)');
  assert(schedulerDebugInfo().subscribers === 1, '(c) the boil subscriber is back on the chain');
  assert(api!.currentFrame.value === 2, '(c) resumes mid-cadence — currentFrame not reset by the hold');

  api!.stop();
  scope.stop();
  await nextTick();
  assert(!armed(), '(c) teardown disarms the scheduler');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`hold.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`hold.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
