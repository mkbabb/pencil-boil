/**
 * cache.proof — the useBoilCache generic-value invariants (and its shared LRU with frames).
 *
 *   node --import ./proofs/loader.mjs proofs/cache.proof.ts
 *
 * Proofs:
 *   (a) a repeated key returns the SAME cached value (compute runs once) — for a scalar T,
 *       not just an array.
 *   (b) a frame ARRAY rides the same LRU as a scalar — one cache, one cap, whatever the
 *       cached shape (the 0.11 surface, after the `useBoilFrames` alias was retired).
 *   (c) LRU eviction by insertion order with a small explicit cap.
 *   (d) onEvict (0.9.2): the disposer fires with the EVICTED value, exactly once, on LRU
 *       eviction — the disposal seam for a cached native resource (an object URL, a bitmap).
 *   (e) onEvict is per-VALUE, not per-call: an entry with no disposer evicts silently even
 *       when the evicting call carries one (the mixed-type LRU guard — a resource consumer
 *       must never run its disposer on a plain frame-array entry it happens to evict).
 *
 * The module-level cache is process-fresh here (own node process), so insertion order is
 * fully controlled.
 */

import { useBoilCache } from '../src/frames.ts';

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

// (a) scalar memoization — compute runs exactly once per key.
{
  let calls = 0;
  const v1 = useBoilCache(['scalar', 7], () => {
    calls += 1;
    return 41 + calls;
  });
  const v2 = useBoilCache(['scalar', 7], () => {
    calls += 1;
    return 999;
  });
  assert(v1 === 42 && v2 === 42, '(a) a repeated key returns the first computed scalar');
  assert(calls === 1, '(a) a cache hit does not re-run compute');
}

// (b) one cache, whatever the shape — a frame array is memoized by the same Map that holds a
// scalar, so one cap governs all boil memoization.
{
  let frameCalls = 0;
  const key = ['shared', 3];
  const a = useBoilCache(key, () => {
    frameCalls += 1;
    return ['f0', 'f1'];
  });
  const b = useBoilCache<string[]>(key, () => {
    frameCalls += 1;
    return ['x'];
  });
  assert(a === b, '(b) a frame array is cached in the SAME entry a scalar would occupy');
  assert(frameCalls === 1, '(b) the entry was computed once — one Map, one cap');
}

// (c) LRU eviction with an explicit small cap.
{
  let calls = 0;
  const gen = (v: string) => () => {
    calls += 1;
    return v;
  };
  useBoilCache(['P'], gen('P'), 2); // miss
  useBoilCache(['Q'], gen('Q'), 2); // miss (cache: P,Q at cap)
  useBoilCache(['P'], gen('P'), 2); // hit => touch P (cache: Q,P)
  const before = calls;
  useBoilCache(['R'], gen('R'), 2); // miss => evict oldest (Q)
  assert(calls === before + 1, '(c) a miss past cap runs compute once');
  useBoilCache(['P'], gen('P'), 2); // hit — P was touched, survived
  assert(calls === before + 1, '(c) a touched entry survives eviction');
  useBoilCache(['Q'], gen('Q'), 2); // miss — Q was the evicted oldest
  assert(calls === before + 2, '(c) the untouched oldest entry was evicted');
}

// (d)/(e) onEvict — the 0.9.2 disposal seam (the native-resource release that ends
// residency accretion). Runs after (c), which deterministically leaves the cache holding
// exactly two disposer-less entries ({'P','Q'}), so the eviction order below is controlled.
{
  const disposed: unknown[] = [];
  const closeSpy = (v: unknown): number => disposed.push(v);

  // ev-A carries a disposer; its insertion evicts the disposer-LESS oldest (P) — silently,
  // because the disposer is bound to ev-A's VALUE, not to this evicting call.
  useBoilCache(['ev-A'], () => 'bmpA', 2, closeSpy);
  assert(
    disposed.length === 0,
    '(e) evicting a disposer-less entry runs no disposer, though the evicting call carries one',
  );

  // ev-B (no disposer) evicts the other disposer-less oldest (Q) — still silent.
  useBoilCache(['ev-B'], () => 'bmpB', 2);
  assert(disposed.length === 0, '(e) a disposer-less eviction stays silent');

  // ev-C evicts ev-A (the disposer-bearing oldest) → its disposer fires with ev-A's value.
  useBoilCache(['ev-C'], () => 'bmpC', 2);
  assert(disposed.length === 1, '(d) onEvict fires exactly once on LRU eviction');
  assert(disposed[0] === 'bmpA', '(d) onEvict receives the EVICTED value, not the evictor');

  // A re-miss for ev-A recomputes; the consumed disposer does not linger to re-fire.
  useBoilCache(['ev-A'], () => 'bmpA2', 2);
  assert(disposed.length === 1, "(d) an evicted key's disposer does not re-fire on recompute");
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`cache.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`cache.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
