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
import { ellipsePoints, perturbPointsClosed } from '../src/path.ts';

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

// ── ellipsePoints — a closed wobble ring (IR: number pairs, not a path string) ──
{
  const allFinitePairs = (pts: Array<[number, number]>) =>
    pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  const e = ellipsePoints(50, 50, 20, 14, { segments: 16, seed: 9 });
  // the loop runs i = 0..seg inclusive => seg + 1 points (seg = 16).
  assert(e.length === 17, '(ellipse) emits segments + 1 points (i = 0..seg inclusive)');
  assert(Array.isArray(e[0]) && e[0].length === 2, '(ellipse) yields [x, y] number pairs, not a string');
  assert(allFinitePairs(e), '(ellipse) every coordinate is finite');

  const e2 = ellipsePoints(50, 50, 20, 14, { segments: 16, seed: 9 });
  assert(JSON.stringify(e) === JSON.stringify(e2), '(ellipse) deterministic for a fixed seed');
  const e3 = ellipsePoints(50, 50, 20, 14, { segments: 16, seed: 10 });
  assert(JSON.stringify(e) !== JSON.stringify(e3), '(ellipse) distinct seeds diverge');

  // segments floors at a minimum of 12 (toPositiveInt(..., 16, 12)).
  const eMin = ellipsePoints(50, 50, 20, 14, { segments: 4, seed: 9 });
  assert(eMin.length === 13, '(ellipse) segments clamps to a floor of 12 (=> 13 points)');
}

// ── perturbPointsClosed — perturb a closed ring, every vertex, local-tangent normal ──
{
  const allFinitePairs = (pts: Array<[number, number]>) =>
    pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  const ring = ellipsePoints(50, 50, 20, 20, { segments: 16, seed: 3 });

  const p1 = perturbPointsClosed(ring, 1.5, 7);
  assert(p1.length === ring.length, '(perturbClosed) preserves the point count');
  assert(allFinitePairs(p1), '(perturbClosed) every perturbed coordinate is finite');
  assert(
    JSON.stringify(p1) === JSON.stringify(perturbPointsClosed(ring, 1.5, 7)),
    '(perturbClosed) deterministic for a fixed seed',
  );
  assert(JSON.stringify(p1) !== JSON.stringify(ring), '(perturbClosed) a non-zero amount moves the ring');

  const p0 = perturbPointsClosed(ring, 0, 7);
  assert(JSON.stringify(p0) === JSON.stringify(ring), '(perturbClosed) a zero amount holds every point');

  const tiny: Array<[number, number]> = [
    [0, 0],
    [1, 1],
  ];
  assert(
    JSON.stringify(perturbPointsClosed(tiny, 5, 7)) === JSON.stringify(tiny),
    '(perturbClosed) a ring of < 3 points passes through unchanged',
  );
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
