/**
 * prebake.proof — boilLineFrames / boilRectFrames invariants.
 *
 *   node --import ./proofs/loader.mjs proofs/prebake.proof.ts
 *
 * Proofs:
 *   (a) frame COUNT: boilLineFrames/boilRectFrames emit exactly `frameCount` strings.
 *   (b) DETERMINISM: a fixed seed emits byte-identical frame sets across calls (pure).
 *   (c) SHIVER: with a non-zero boil amount, later frames differ from frame 0 (the base).
 *   (d) FINITENESS: every serialized path holds only finite coordinates.
 *   (e) RECT closure: every rect frame is a closed path (ends in ` Z`).
 *   (f) catmullRomToBezier: the serializer the boil frames ride — degenerate/linear/cubic
 *       forms, determinism, finiteness (previously only transitively exercised).
 *   (g) resolveEasing: the string→curve resolver — named curves map, unknown → easeOutCubic.
 */

import { boilLineFrames, boilRectFrames, catmullRomToBezier } from '../src/path.ts';
import {
  resolveEasing,
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  linear,
} from '../src/easings.ts';

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

function allFinite(d: string): boolean {
  const nums = d.match(/-?\d+(\.\d+)?/g) ?? [];
  return nums.every((n) => Number.isFinite(Number(n)));
}

// (a) count
{
  const lf = boilLineFrames(0, 0, 100, 0, 4, 1.2, { seed: 7 });
  const rf = boilRectFrames(0, 0, 100, 60, 4, 1.2, { seed: 7 });
  assert(lf.length === 4, '(a) boilLineFrames emits exactly frameCount strings');
  assert(rf.length === 4, '(a) boilRectFrames emits exactly frameCount strings');
}

// (b) determinism / purity
{
  const a = boilLineFrames(10, 20, 200, 40, 5, 0.9, { seed: 13, jagged: true });
  const b = boilLineFrames(10, 20, 200, 40, 5, 0.9, { seed: 13, jagged: true });
  assert(a.join('§') === b.join('§'), '(b) boilLineFrames is deterministic for a fixed seed');
  const ra = boilRectFrames(5, 5, 90, 50, 3, 0.7, { seed: 31 });
  const rb = boilRectFrames(5, 5, 90, 50, 3, 0.7, { seed: 31 });
  assert(ra.join('§') === rb.join('§'), '(b) boilRectFrames is deterministic for a fixed seed');
}

// (c) shiver — frame 0 is the base, a later frame perturbs off it
{
  const lf = boilLineFrames(0, 0, 100, 100, 4, 1.5, { seed: 3 });
  assert(lf[0] !== lf[1], '(c) a boiled line shivers frame 0 → frame 1 under a non-zero amount');
  const zero = boilLineFrames(0, 0, 100, 100, 4, 0, { seed: 3 });
  assert(
    zero.every((f) => f === zero[0]),
    '(c) a zero boil amount holds every frame identical to the base',
  );
}

// (d) finiteness
{
  const lf = boilLineFrames(0, 0, 100, 0, 4, 1.2, { seed: 7 });
  const rf = boilRectFrames(0, 0, 100, 60, 4, 1.2, { seed: 7 });
  assert(lf.every(allFinite), '(d) every boilLineFrames path holds only finite coordinates');
  assert(rf.every(allFinite), '(d) every boilRectFrames path holds only finite coordinates');
}

// (e) rect closure
{
  const rf = boilRectFrames(0, 0, 100, 60, 4, 1.2, { seed: 7 });
  assert(rf.every((f) => f.trimEnd().endsWith('Z')), '(e) every rect frame is a closed path');
}

// (f) catmullRomToBezier — the serializer every boil frame rides.
{
  assert(catmullRomToBezier([]) === '', '(f) < 2 points serialize to the empty string');
  assert(catmullRomToBezier([[3, 4]]) === '', '(f) a single point serializes to the empty string');
  assert(
    catmullRomToBezier([
      [0, 0],
      [10, 10],
    ]) === 'M0,0 L10,10',
    '(f) exactly two points serialize as a straight M…L segment (no cubic)',
  );
  const cubic = catmullRomToBezier([
    [0, 0],
    [10, 10],
    [20, 0],
  ]);
  assert(cubic.startsWith('M0,0') && cubic.includes(' C'), '(f) three+ points serialize as cubic bezier segments');
  assert(
    cubic ===
      catmullRomToBezier([
        [0, 0],
        [10, 10],
        [20, 0],
      ]),
    '(f) catmullRomToBezier is deterministic (pure)',
  );
  assert(allFinite(cubic), '(f) every serialized coordinate is finite');
}

// (g) resolveEasing — the config-string → curve resolver.
{
  assert(resolveEasing('easeInCubic') === easeInCubic, '(g) "easeInCubic" resolves to easeInCubic');
  assert(resolveEasing('easeInOutCubic') === easeInOutCubic, '(g) "easeInOutCubic" resolves to easeInOutCubic');
  assert(resolveEasing('linear') === linear, '(g) "linear" resolves to linear');
  assert(resolveEasing('easeOutCubic') === easeOutCubic, '(g) "easeOutCubic" resolves to easeOutCubic');
  assert(resolveEasing('nonsense') === easeOutCubic, '(g) an unknown name defaults to easeOutCubic');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`prebake.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`prebake.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
