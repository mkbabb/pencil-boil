/**
 * cache.proof — the useBoilCache generic-value invariants (and its shared LRU with frames).
 *
 *   node --import ./proofs/loader.mjs proofs/cache.proof.ts
 *
 * Proofs:
 *   (a) a repeated key returns the SAME cached value (compute runs once) — for a scalar T,
 *       not just an array.
 *   (b) useBoilFrames rides the SAME underlying LRU as useBoilCache (one cap governs both).
 *   (c) LRU eviction by insertion order with a small explicit cap.
 *
 * The module-level cache is process-fresh here (own node process), so insertion order is
 * fully controlled.
 */

import { useBoilCache, useBoilFrames } from '../src/frames.ts';

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

// (b) shared LRU — a value stored via useBoilCache is retrievable via useBoilFrames when the
// key + shape line up (frames delegate to the same Map), and vice-versa the caches do not
// double-count.
{
  let frameCalls = 0;
  const key = ['shared', 3];
  const a = useBoilFrames(key, () => {
    frameCalls += 1;
    return ['f0', 'f1'];
  });
  // useBoilCache with the SAME key hits the entry useBoilFrames just wrote — one Map.
  const b = useBoilCache<string[]>(key, () => {
    frameCalls += 1;
    return ['x'];
  });
  assert(a === b, '(b) useBoilCache and useBoilFrames share one underlying entry per key');
  assert(frameCalls === 1, '(b) the shared entry was computed once across both APIs');
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
