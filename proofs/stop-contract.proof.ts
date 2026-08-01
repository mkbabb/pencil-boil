/**
 * stop-contract.proof — THE `stop()` NO-THROW CONTRACT (0.11.0).
 *
 *   node --import ./proofs/loader.mjs proofs/stop-contract.proof.ts
 *
 * Every `stop()` this package hands out — `BoilHandle`, `SequenceHandle`, the inert PRM
 * handle — returns without throwing, in EVERY lifecycle phase, so a caller never needs a
 * `try { h.stop() } catch {}` wrapper. The contract exists because the swarm of such
 * wrappers downstream (11 sites across 6 files in the sudoku estate) is unfalsifiable by
 * inspection: a reader cannot tell whether the guard defends against a real throw or hides a
 * lifecycle bug. Move the guarantee INTO the library, prove it here, and the wrappers are
 * provably dead code.
 *
 * The only statement on any withdrawal path that can throw is the host-facing teardown —
 * `cancelAnimationFrame` / `clearTimeout` — which an embedding page may patch (analytics
 * shims, zone.js-style monkey-patches, a torn-down iframe whose `window` is dead). The
 * HOSTILE HOST arm below is that case, and it is the arm that reds without the cure.
 *
 * Proofs:
 *   (a) PHASES: stop() returns on a handle that never started, one mid-flight, one stopped
 *       from inside its own tick, one that already completed, one stopped twice, one whose
 *       subscriber PRM already cleared, one after its composable unmounted — frame AND
 *       sequence kinds, plus the inert PRM `createStrokeDrawIn` handle.
 *   (b) HOSTILE HOST: with `cancelAnimationFrame` and `clearTimeout` both throwing, stop()
 *       still returns — for a mid-flight frame subscriber, a mid-flight sequence, and a
 *       composable teardown.
 *   (c) THE SWALLOW HIDES NOTHING (negative control): under the hostile host the withdrawal
 *       still LANDS — the subscriber leaves the set, the count falls, and a subsequent tick
 *       never advances the stopped mark. A no-throw contract that leaked an enrolled
 *       subscriber would pass (b) and fail here.
 */

import { effectScope, nextTick } from 'vue';

/** The REAL timer, captured before the env stub replaces the global. */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, ms));

// ── env stub: rAF + timers + matchMedia, with a hostile-host switch ──

let pendingCb: ((t: number) => void) | null = null;
const pendingTimers = new Map<number, () => void>();
let nextRafId = 1;
let nextTimerId = 1;
let reduceMotion = false;
let hostile = false;
const prmChangeListeners: Array<(e: { matches: boolean }) => void> = [];

function installEnv(): void {
  const win = {
    requestAnimationFrame(cb: (t: number) => void): number {
      pendingCb = cb;
      return nextRafId++;
    },
    cancelAnimationFrame(_id: number): void {
      if (hostile) throw new Error('host: cancelAnimationFrame is patched and throws');
      pendingCb = null;
    },
    setTimeout(cb: () => void, _delay?: number): number {
      const id = nextTimerId++;
      pendingTimers.set(id, cb);
      return id;
    },
    clearTimeout(id: number): void {
      if (hostile) throw new Error('host: clearTimeout is patched and throws');
      pendingTimers.delete(id);
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

/** Run `fn` and report whether it returned without throwing (the whole contract, once). */
function returns(fn: () => void, label: string): void {
  try {
    fn();
    assert(true, label);
  } catch (err) {
    assert(false, `${label} — THREW: ${(err as Error).message}`);
  }
}

{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('onUnmounted is called')) return;
    warn(...args);
  };
}

installEnv();
const { useLineBoil, createBoilTicker, createSequenceSubscription, createStrokeDrawIn, schedulerDebugInfo } =
  await import('../src/vue.ts');

// ── (a) PHASES — the benign host; every phase returns ──

// never started
{
  const t = createBoilTicker(4, 125, () => {});
  returns(() => t.stop(), '(a) frame handle stopped before start returns');
  const s = createSequenceSubscription({ durationMs: 200, onProgress: () => {} });
  returns(() => s.stop(), '(a) sequence handle stopped before start returns');
}

// mid-flight
{
  const t = createBoilTicker(4, 125, () => {});
  t.start();
  assert(schedulerDebugInfo().subscribers === 1, '(a) the frame subscriber enrolled');
  returns(() => t.stop(), '(a) frame handle stopped MID-FLIGHT returns');
  assert(schedulerDebugInfo().subscribers === 0, '(a) mid-flight stop withdrew the subscriber');
}
{
  const s = createSequenceSubscription({ durationMs: 400, onProgress: () => {} });
  s.start();
  pump(1);
  returns(() => s.stop(), '(a) sequence handle stopped MID-TWEEN returns');
  assert(schedulerDebugInfo().subscribers === 0, '(a) mid-tween stop withdrew the subscriber');
}

// from inside its own tick
{
  let threwInTick: Error | null = null;
  let ticker: { start: () => void; stop: () => void } | null = null;
  ticker = createBoilTicker(4, 16, () => {
    try {
      ticker!.stop();
    } catch (err) {
      threwInTick = err as Error;
    }
  });
  ticker.start();
  pump(3);
  assert(threwInTick === null, '(a) frame handle stopped FROM INSIDE ITS OWN TICK returns');
}
{
  let threwInTick: Error | null = null;
  let seq: { start: () => void; stop: () => void } | null = null;
  seq = createSequenceSubscription({
    durationMs: 400,
    onProgress: () => {
      try {
        seq!.stop();
      } catch (err) {
        threwInTick = err as Error;
      }
    },
  });
  seq.start();
  pump(2);
  assert(threwInTick === null, '(a) sequence handle stopped FROM INSIDE onProgress returns');
}

// after completion (the tween self-unsubscribed)
{
  let done = false;
  const s = createSequenceSubscription({
    durationMs: 1,
    onProgress: () => {},
    onComplete: () => {
      done = true;
    },
  });
  s.start();
  await sleep(4);
  pump(2);
  assert(done, '(a) the tween completed and self-unsubscribed');
  returns(() => s.stop(), '(a) sequence handle stopped AFTER COMPLETION returns');
}

// twice
{
  const t = createBoilTicker(4, 125, () => {});
  t.start();
  t.stop();
  returns(() => t.stop(), '(a) DOUBLE stop returns (idempotent withdrawal)');
}

// after PRM cleared the set centrally
{
  const t = createBoilTicker(4, 125, () => {});
  t.start();
  setReduceMotion(true);
  assert(schedulerDebugInfo().subscribers === 0, '(a) PRM engage cleared every subscriber');
  returns(() => t.stop(), '(a) stop AFTER a central PRM clear returns');

  // the inert handle PRM hands back
  const el = {
    style: {} as Record<string, string>,
    getTotalLength: () => 120,
  } as unknown as SVGGeometryElement;
  const inert = createStrokeDrawIn(el, { durationMs: 300 });
  returns(() => inert.stop(), '(a) the inert PRM createStrokeDrawIn handle stops without throwing');
  setReduceMotion(false);
}

// after the composable that owns it unmounted
{
  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | null = null;
  scope.run(() => {
    api = useLineBoil(4, 125);
  });
  await nextTick();
  scope.stop();
  returns(() => api!.stop(), '(a) stop AFTER the owning scope tore down returns');
}

// ── (b) HOSTILE HOST — cancelAnimationFrame AND clearTimeout throw ──

{
  const t = createBoilTicker(4, 125, () => {});
  t.start();
  const before = schedulerDebugInfo().subscribers;
  hostile = true;
  returns(() => t.stop(), '(b) HOSTILE HOST: mid-flight frame stop returns');
  hostile = false;
  assert(before === 1, '(b) the hostile arm ran against a live subscriber');
  // (c) the swallow hides nothing — the withdrawal landed anyway
  assert(
    schedulerDebugInfo().subscribers === 0,
    '(c) NEGATIVE CONTROL: the hostile-host withdrawal still LANDED (subscriber left the set)',
  );
}

{
  let advanced = 0;
  const t = createBoilTicker(4, 16, () => {
    advanced += 1;
  });
  t.start();
  pendingTimers.clear();
  pendingCb = null;
  hostile = true;
  returns(() => t.stop(), '(b) HOSTILE HOST: a second mid-flight stop returns');
  hostile = false;
  await sleep(24);
  const seen = advanced;
  pump(3);
  assert(
    advanced === seen,
    '(c) NEGATIVE CONTROL: the stopped mark never advances again under the hostile host',
  );
}

{
  const s = createSequenceSubscription({ durationMs: 400, onProgress: () => {} });
  s.start();
  hostile = true;
  returns(() => s.stop(), '(b) HOSTILE HOST: mid-tween sequence stop returns');
  hostile = false;
  assert(
    schedulerDebugInfo().subscribers === 0,
    '(c) NEGATIVE CONTROL: the hostile-host tween withdrawal LANDED',
  );
}

// The composable's own teardown path: `useLineBoil` exposes the same `stop` its
// `onUnmounted` hook calls, so driving it explicitly under the hostile host proves the
// teardown a real component would run. (Headless, `onUnmounted` is a no-op — the scope only
// disposes the watchEffect, which is why the withdrawal has to be driven by hand here.)
{
  const scope = effectScope();
  let api: ReturnType<typeof useLineBoil> | null = null;
  scope.run(() => {
    api = useLineBoil(4, 125);
  });
  await nextTick();
  assert(schedulerDebugInfo().subscribers === 1, '(b) the composable enrolled its subscriber');
  scope.stop();
  hostile = true;
  returns(() => api!.stop(), '(b) HOSTILE HOST: composable teardown stop() returns');
  hostile = false;
  assert(
    schedulerDebugInfo().subscribers === 0,
    '(c) NEGATIVE CONTROL: the teardown withdrawal LANDED under the hostile host',
  );
}

// ── report ──

console.log('');
if (failures.length > 0) {
  console.log(`stop-contract.proof: ${failures.length} FAILURE(S), ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`stop-contract.proof: ${passed} assertions passed`);
