/**
 * raster-theme-flip.proof — a re-bake captures the cascade AS IT IS AFTER the change that
 * triggered it, not as it was before.
 *
 *   node --import ./proofs/loader.mjs proofs/raster-theme-flip.proof.ts
 *
 * WHY THIS IS A GATE. `poseSvg` is a consumer callback and it is entitled to read the live
 * cascade — `getComputedStyle(el).color`, a `--custom-property` — because that is how a themed
 * pose gets its ink. A theme flip therefore has TWO effects in one flush: it flips the
 * consumer's `cacheKey` (which fires the reactive-opts watch, a `pre` watcher) and it writes
 * the `<html>` class the cascade hangs off (which theme libraries do from a `post` watcher, or
 * later still). Capture synchronously and the `pre` watcher wins the race: every pose bakes
 * the OLD theme's ink and then caches under the NEW key, where nothing ever invalidates it
 * again. The surface is left carrying the ink of the theme it just left, and only a reload
 * repairs it.
 *
 * BORN RED at 0.10.0: measured on the deployed artifact at both engines, one toggle left a
 * near-black wordmark on near-black paper — logo bake `rgb(12,12,12)` against a live
 * `rgb(17,15,14)`, contrast 1.02:1, with the pose blobs demonstrably RE-MINTED across the
 * toggle. The bake fired; it read the wrong cascade.
 *
 * The model here is that exact shape, reduced: `cascadeInk` is a plain cell (non-reactive,
 * like `getComputedStyle`) written by a `post`-flush watcher (like a theme library's class
 * write), and `poseSvg` reads it at capture time (like the app's does). The assertion is over
 * what each capture SERIALIZED — pixels are the Playwright lane's business.
 *
 * Proofs:
 *   (a) FRESH: the first bake serializes the light-theme ink.
 *   (b) THE FLIP: after one flip, every newly captured pose carries the DARK ink — the bake
 *       read the post-change cascade.
 *   (c) NO THRASH: the flip costs exactly `poseCount` captures, not two rounds of them.
 *   (d) SUPERSESSION: two flips inside one frame resolve to the FINAL cascade, and the
 *       superseded bake neither clobbers the bitmaps nor leaves them null.
 */

import { effectScope, nextTick, ref, watch } from 'vue';
import { serializePoseSvg } from '../src/raster.ts';
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

// Headlessly there is no component instance, so the composable's onMounted/onUnmounted warn.
{
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && /on(Mounted|Unmounted) is called/.test(args[0])) return;
    warn(...args);
  };
}

const env = installCaptureEnv(2);
const { useRasterStack } = await import('../src/vue.ts');

/** Drain the capture chain AND the bake's paint yield (nextTick → rAF/timeout stand-in). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const LIGHT = '#0a0a0a';
const DARK = '#edece9';
const POSE_COUNT = 2;

// The cascade: a plain cell, NOT reactive — `getComputedStyle` is not reactive either.
let cascadeInk = LIGHT;
const isDark = ref(false);
// The theme library's `<html>` class write. `post` flush, so it lands AFTER the `pre` watcher
// the raster stack keys its re-bake on — the ordering that IS the defect.
watch(
  isDark,
  (d) => {
    cascadeInk = d ? DARK : LIGHT;
  },
  { flush: 'post' },
);

const scope = effectScope();
let api: ReturnType<typeof useRasterStack> | undefined;
scope.run(() => {
  api = useRasterStack(() => ({
    // A boolean proxy for the ink, exactly as a consumer writes it.
    cacheKey: `logo|${isDark.value ? 'd' : 'l'}`,
    poseCount: POSE_COUNT,
    poseSvg: (pose: number) =>
      serializePoseSvg({
        width: 320,
        height: 60,
        defs: `<filter id="w-p${pose}"><feTurbulence baseFrequency="0.012" seed="${pose}"/></filter>`,
        // The cascade read at capture time — the whole point.
        body: `<text x="0" y="48" fill="${cascadeInk}" filter="url(#w-p${pose})">sudoku</text>`,
      }),
    cssSize: { width: 320, height: 60 },
  }));
});
await nextTick();

const inked = (svg: string, hex: string) => svg.includes(`fill="${hex}"`);

// (a) FRESH — the mount bake carries the light ink.
{
  api!.rebake(); // stands in for the onMounted bake
  await flush();
  assert(env.blobs.length === POSE_COUNT, '(a) the fresh bake captured poseCount poses');
  assert(
    env.blobs.every((b) => inked(b, LIGHT)),
    '(a) every fresh pose serialized the LIGHT cascade ink',
  );
  assert(api!.ready.value === true, '(a) ready on the fresh bake');
}

// (b)+(c) THE FLIP — the re-bake reads the cascade the flip produced, once.
{
  env.reset();
  isDark.value = true;
  await nextTick();
  await flush();
  assert(
    env.blobs.length === POSE_COUNT,
    '(c) the flip cost EXACTLY poseCount captures — no pre-flip round thrown away',
  );
  assert(
    env.blobs.length > 0 && env.blobs.every((b) => inked(b, DARK)),
    '(b) every re-baked pose serialized the POST-FLIP cascade ink (born RED at 0.10.0)',
  );
  assert(
    !env.blobs.some((b) => inked(b, LIGHT)),
    '(b) no pose carried the ink of the theme just left',
  );
  assert(
    api!.bitmaps.value?.length === POSE_COUNT,
    '(b) the re-bake resolved — the surface is not stranded on the fallback',
  );
}

// (d) SUPERSESSION — two flips inside one frame: the last cascade wins, exactly once.
{
  env.reset();
  isDark.value = false;
  await nextTick();
  isDark.value = true;
  await nextTick();
  await flush();
  assert(
    env.blobs.length > 0 && env.blobs.every((b) => inked(b, DARK)),
    '(d) a double flip resolves to the FINAL cascade, not to the one it passed through',
  );
  assert(
    api!.bitmaps.value?.length === POSE_COUNT,
    '(d) the superseded bake left the bitmaps resolved, not null',
  );
}

scope.stop();
await nextTick();

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`raster-theme-flip.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`raster-theme-flip.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
