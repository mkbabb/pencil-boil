/**
 * celestial.proof — point-count, determinism, and seed-stability invariants for the
 * celestial polygon generators (wobbleDiamond, wobbleStarPolygon, generateSunRays).
 *
 *   node --import ./proofs/loader.mjs proofs/celestial.proof.ts
 *
 * These are seeded (mulberry32) pure generators: a given seed must always emit the same
 * SVG `points` string, distinct seeds must diverge, and every coordinate must be finite.
 */

import { wobbleDiamond, wobbleStarPolygon, generateSunRays } from '../src/celestial.ts';

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

/** Split an SVG polygon `points` string into [x, y] number pairs. */
function coords(points: string): Array<[number, number]> {
  return points
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [x, y] = tok.split(',').map(Number);
      return [x, y] as [number, number];
    });
}

function allFinite(points: string): boolean {
  return coords(points).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

// ── wobbleDiamond — 4 vertices ──
{
  const d = wobbleDiamond(35, 40, 6, 10, 7);
  assert(coords(d).length === 4, '(diamond) emits exactly 4 vertices');
  assert(allFinite(d), '(diamond) every coordinate is finite');
  assert(d === wobbleDiamond(35, 40, 6, 10, 7), '(diamond) deterministic for a fixed seed');
  assert(d !== wobbleDiamond(35, 40, 6, 10, 8), '(diamond) distinct seeds diverge');
}

// ── wobbleStarPolygon — 10 vertices (5-point star) ──
{
  const s = wobbleStarPolygon(160, 20, 12, 5, 3);
  assert(coords(s).length === 10, '(star) emits exactly 10 vertices');
  assert(allFinite(s), '(star) every coordinate is finite');
  assert(s === wobbleStarPolygon(160, 20, 12, 5, 3), '(star) deterministic for a fixed seed');
  assert(s !== wobbleStarPolygon(160, 20, 12, 5, 4), '(star) distinct seeds diverge');
}

// ── generateSunRays — { outerPoly, innerPoly }, 20 points each (10 rays × 2) ──
{
  const r = generateSunRays(42);
  assert(coords(r.outerPoly).length === 20, '(rays) outerPoly has 20 points (10 rays × 2)');
  assert(coords(r.innerPoly).length === 20, '(rays) innerPoly has 20 points (10 rays × 2)');
  assert(allFinite(r.outerPoly) && allFinite(r.innerPoly), '(rays) every coordinate is finite');

  const r2 = generateSunRays(42);
  assert(
    r.outerPoly === r2.outerPoly && r.innerPoly === r2.innerPoly,
    '(rays) deterministic for a fixed seed',
  );
  const r3 = generateSunRays(43);
  assert(r.outerPoly !== r3.outerPoly, '(rays) distinct seeds diverge');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`celestial.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`celestial.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
