/**
 * vue-raster-stack.proof — G2.3: `useRasterStack` never captures at a non-positive box.
 *
 *   node --import ./proofs/loader.mjs proofs/vue-raster-stack.proof.ts
 *
 * WHY THIS IS A GATE: an `<svg>` element has no `offsetWidth`, so an element-size measure
 * seeds 0 and the consumer falls back to a nominal box (the logo's 72 px — 1.56× short of the
 * real one). The stack then bakes twice: once at the wrong size, once when layout lands. The
 * first bake is pure waste on the critical mount path AND it is what the surface displays
 * until the second resolves. A zero box means "not measured yet", not "capture a 1×1" — so
 * the bake returns BEFORE the token bump (nothing nulls `urls`, no in-flight bake is
 * orphaned) and the reactive opts watch re-bakes when the box lands.
 *
 * Headless shape: the composable is driven inside an `effectScope`, so `onMounted` never
 * fires (no component instance) — `rebake()` stands in for the mount bake, and the opts watch
 * drives the rest, exactly as it does in a real mount.
 *
 * Proofs:
 *   (a) ZERO BOX: a 0×0 cssSize captures NOTHING; `urls` stays null (the consumer keeps
 *       its live-filter fallback).
 *   (b) HALF BOX: one non-positive dimension is still non-positive — no capture.
 *   (c) THE BOX LANDS: exactly ONE bake runs — `poseCount` captures total, none of them at
 *       the pre-layout box, each at `cssSize × dpr` device px.
 *   (d) COLLAPSE: a box that falls back to zero (a drawer closing, an element detached) does
 *       NOT clobber the resolved urls — the guard returns before the token bump.
 *   (e) URL LIFETIME: the composable mints one URL per pose and OWNS it — a superseded set
 *       stays valid and reachable in the size-keyed cache (0.12.0) rather than being revoked
 *       at the swap, and teardown revokes every handle the surface ever minted, so no handle
 *       outlives the surface and none is pulled out from under a rendered image.
 */

import { effectScope, nextTick, ref } from 'vue';
import { serializePoseSvg, type RasterStackOptions } from '../src/raster.ts';
import { installCaptureEnv } from './capture-env.ts';

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

// The composable registers onMounted/onUnmounted; headlessly there is no component instance,
// so Vue warns. Teardown and the mount bake are driven explicitly — silence those two.
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && /on(Mounted|Unmounted) is called/.test(args[0])) return;
    warn(...args);
  };
}

const env = installCaptureEnv(2);
// Import AFTER the env is installed — vue.ts reads `document` / `window` at module load.
const { useRasterStack } = await import('../src/vue.ts');

/** Drain the capture's microtask chain (image onload → canvas → encode). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

const POSE_COUNT = 2;
function poseSvg(pose: number): string {
  return serializePoseSvg({
    width: 320,
    height: 60,
    defs: `<filter id="w-p${pose}"><feTurbulence baseFrequency="0.012" seed="${pose}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3"/></filter>`,
    body: `<text x="0" y="48" fill="#1a1a1a" filter="url(#w-p${pose})">sudoku</text>`,
  });
}

const opts = ref<RasterStackOptions>({
  cacheKey: 'logo|dark',
  poseCount: POSE_COUNT,
  poseSvg,
  cssSize: { width: 0, height: 0 }, // an <svg> has no offsetWidth — the pre-layout seed
});

const scope = effectScope();
let api: ReturnType<typeof useRasterStack> | undefined;
scope.run(() => {
  api = useRasterStack(opts);
});
await nextTick();

// (a) ZERO BOX — the mount bake captures nothing.
{
  api!.rebake(); // stands in for the onMounted bake
  await flush();
  assert(env.blobs.length === 0, '(a) a 0×0 cssSize captures NOTHING (zero blob documents)');
  assert(api!.urls.value === null, '(a) urls stays null — the consumer keeps the live-filter fallback');
  assert(api!.ready.value === false, '(a) ready is false at a zero box');
}

// (b) HALF BOX — one non-positive dimension is non-positive.
{
  opts.value = { ...opts.value, cssSize: { width: 320, height: 0 } };
  await nextTick();
  await flush();
  assert(env.blobs.length === 0, '(b) a zero HEIGHT captures nothing either');
  assert(api!.urls.value === null, '(b) urls still null after the half-box watch fire');
}

// (c) THE BOX LANDS — exactly one bake, at the real box.
{
  opts.value = { ...opts.value, cssSize: { width: 320, height: 60 } };
  await nextTick();
  await flush();
  assert(
    env.blobs.length === POSE_COUNT,
    '(c) the landed box bakes EXACTLY ONCE — poseCount captures in total, no pre-layout bake',
  );
  assert(api!.urls.value?.length === POSE_COUNT, '(c) every pose resolved to a URL');
  assert(api!.ready.value === true, '(c) ready flips true on the landed bake');
  assert(
    env.canvases.every((c) => c.width === 640 && c.height === 120),
    '(c) every capture ran at cssSize × dpr = 640×120 (no 1×1 stand-in among them)',
  );
  assert(
    env.encodes.every((e) => e.width === 640 && e.height === 120),
    '(c) every encode read the device-px capture surface (640×120)',
  );
  assert(
    env.bitmapCopies === 0,
    '(c) ZERO ImageBitmap copies — the bake encodes the capture canvas itself',
  );
  // The capture revokes its OWN source-SVG handles inside `rasterizePoseToBlob`; what must
  // never be revoked is a POSE handle the surface is currently rendering.
  assert(
    api!.urls.value?.every((u) => env.minted.includes(u) && !env.revoked.includes(u)) === true,
    '(e) every live pose URL was minted here and is still valid',
  );
}

// (d) COLLAPSE — a zero box does not clobber a good bake (the guard returns before the
// token bump, so nothing nulls urls and no stand-in capture supersedes them).
{
  const good = api!.urls.value;
  opts.value = { ...opts.value, cssSize: { width: 0, height: 0 } };
  await nextTick();
  await flush();
  assert(env.blobs.length === POSE_COUNT, '(d) collapsing back to a zero box captures nothing further');
  assert(
    api!.urls.value === good,
    '(d) the SAME urls array survives — nothing nulled it, no stand-in bake superseded it',
  );
  assert(
    good?.every((u) => !env.revoked.includes(u)) === true,
    '(d) the surviving pose URLs were not revoked — the rendered images stay decodable',
  );
}

// (e) RE-BAKE + TEARDOWN — the composable owns every handle it minted.
{
  const stale = [...(api!.urls.value ?? [])];
  opts.value = { ...opts.value, cacheKey: 'logo|light', cssSize: { width: 320, height: 60 } };
  await nextTick();
  await flush();
  assert(
    api!.urls.value?.length === POSE_COUNT && api!.urls.value?.[0] !== stale[0],
    '(e) a re-bake mints a fresh URL set',
  );
  // 0.12.0 changed WHEN the superseded set dies, not WHO owns it. The theme flip above is a
  // key change, and the cache retains the stack it left: flipping back is then free, and the
  // outgoing images stay decodable for the frames between the swap and the new decode — the
  // property the old revoke-at-swap ordering was written to protect, now structural.
  // `poseCacheSize: 1` restores revoke-at-swap exactly, and raster-stack-cache.proof (g)
  // asserts it there.
  assert(
    stale.every((u) => !env.revoked.includes(u)),
    '(e) the superseded set is RETAINED and still valid — the cache holds it for the return',
  );
  assert(
    api!.urls.value?.every((u) => !env.revoked.includes(u)) === true,
    '(e) the LIVE set is never revoked out from under the surface',
  );
}

// Teardown. This arm used to revoke the handles ITSELF and then assert they were revoked —
// a check that could not fail and therefore measured nothing. `useRasterStack` tears down on
// `onScopeDispose` as of 0.12.0, which fires inside a bare `effectScope` as well as inside a
// component, so the composable's OWN cleanup is what runs here and the assertion has teeth.
{
  const held = [...(api!.urls.value ?? [])];
  const revokedBefore = env.revoked.length;
  scope.stop();
  await nextTick();
  assert(
    held.every((u) => env.revoked.includes(u)),
    '(e) every minted handle is revoked by teardown — no object URL outlives the surface',
  );
  assert(
    env.revoked.length > revokedBefore,
    '(e) the composable revoked them, not the proof — teardown did the work itself',
  );
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`vue-raster-stack.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`vue-raster-stack.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
