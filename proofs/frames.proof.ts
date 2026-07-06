/**
 * frames.proof — the useBoilFrames memoizing-cache invariants.
 *
 *   node --import ./proofs/loader.mjs proofs/frames.proof.ts
 *
 * Proofs:
 *   (a) a repeated key returns the SAME cached array (generator runs once).
 *   (b) non-integer key parts quantize to 4 decimals (same key within tolerance).
 *   (c) LRU: exceeding maxEntries evicts the oldest; a touched entry survives.
 *
 * The module-level FRAME_CACHE is process-fresh here (this file is its own node process),
 * so insertion order is fully controlled — the LRU case runs first, on an empty cache.
 */

import { useBoilFrames } from '../src/frames.ts';

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

// (c) LRU eviction — run FIRST on an empty cache with an explicit small cap.
{
  let calls = 0;
  const gen = (v: string) => () => {
    calls += 1;
    return [v];
  };
  useBoilFrames(['A'], gen('A'), 3); // miss => calls 1
  useBoilFrames(['B'], gen('B'), 3); // miss => calls 2
  useBoilFrames(['C'], gen('C'), 3); // miss => calls 3 (cache: A,B,C — at cap, no evict)
  useBoilFrames(['A'], gen('A'), 3); // hit => touch A (cache: B,C,A); calls unchanged
  assert(calls === 3, '(c) a cache hit does not re-run the generator');

  useBoilFrames(['D'], gen('D'), 3); // miss => calls 4; size 4 > 3 => evict oldest (B)
  const before = calls;
  useBoilFrames(['A'], gen('A'), 3); // hit — A was touched, so it survived eviction
  assert(calls === before, '(c) a touched entry survives LRU eviction');
  useBoilFrames(['B'], gen('B'), 3); // miss — B was the evicted oldest
  assert(calls === before + 1, '(c) the untouched oldest entry was evicted');
}

// (a) memoization — same key returns the same array reference.
{
  const r1 = useBoilFrames(['X', 1, 2], () => [1, 2, 3]);
  const r2 = useBoilFrames(['X', 1, 2], () => [9, 9, 9]);
  assert(r1 === r2, '(a) a repeated key returns the same cached array (generator runs once)');
  assert(r1[0] === 1 && r1.length === 3, '(a) the cached value is the first generation, not the second');
}

// (b) float key normalization — non-integers quantize to 4 decimals.
{
  const a = useBoilFrames(['k', 1.000011], () => ['a']);
  const b = useBoilFrames(['k', 1.000012], () => ['b']); // same key within 4 decimals
  assert(a === b, '(b) float parts within 4 decimals share a key');
  const c = useBoilFrames(['k', 1.0009], () => ['c']); // differs at the 4th decimal
  assert(c[0] === 'c' && c !== a, '(b) float parts differing at 4 decimals key distinctly');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`frames.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`frames.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
