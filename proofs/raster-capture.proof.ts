/**
 * raster-capture.proof — G2.1: the capture stamps the CAPTURE intrinsic on the blob
 * document.
 *
 *   node --import ./proofs/loader.mjs proofs/raster-capture.proof.ts
 *
 * WHY THIS IS A GATE: WebKit rasterizes a filtered SVG-as-image at the document's DECLARED
 * intrinsic size and bilinearly upscales into the `drawImage` dest rect (Chromium re-renders
 * vectorially). A pose serialized at the caller's user-space box therefore bakes at
 * user-space resolution however large the canvas is — measured signature: softRatio FLAT
 * across dpr2→dpr3 (0.3734→0.3739 logo, 0.1259→0.1261 toggle; T4-P1 mark 4 M1), i.e. extra
 * dpr buys zero detail. `raster.ts`'s own stated contract is that the pose is captured at
 * `cssSize * dpr` device px, so the document must DECLARE that size. viewBox is untouched —
 * user space is preserved, only the render resolution moves.
 *
 * Proofs:
 *   (a) INTRINSIC: the blob root's width/height are `round(cssSize × dpr)` device px, NOT
 *       the caller's user-space box.
 *   (b) ROUNDING: a fractional box × dpr rounds (matching the canvas arithmetic exactly).
 *   (c) VIEWBOX UNTOUCHED: an explicit viewBox survives byte-identically — the pose is
 *       re-resolved, never rescaled.
 *   (d) CONTRACT: the stamped intrinsic equals the canvas the capture draws into (one number,
 *       one truth — `raster.ts`'s documented capture box).
 *   (e) BODY UNTOUCHED: everything after the root tag (inlined <defs> included) is
 *       byte-identical to the serialized input.
 *   (f) GUARD: a root without a viewBox throws a named `rasterizePoseToBlob:` error and creates NO
 *       blob — an intrinsic rewrite on a document whose user space is implied BY that
 *       intrinsic would rescale the pose. Fail at bake time, never bake silently wrong (the
 *       `isSelfContainedSvg` discipline).
 *   (g) ORDER: the self-contained guard still precedes the stamp — a `currentColor` leak
 *       rejects on the cascade error, not the viewBox one.
 */

import { rasterizePoseToBlob, serializePoseSvg, type PoseSvgParts } from '../src/raster.ts';
import { installCaptureEnv, rootTag, attr } from './capture-env.ts';

const env = installCaptureEnv(2);

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

/** The grid's shape: a frozen wobble filter inlined, colors resolved to hex literals. */
function gridPoseParts(pose: number, box: { width: number; height: number }): PoseSvgParts {
  return {
    width: box.width,
    height: box.height,
    defs:
      `<filter id="wobble-p${pose}">` +
      `<feTurbulence type="turbulence" baseFrequency="0.012" numOctaves="2" seed="${pose}" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>` +
      `</filter>`,
    body: `<rect x="10" y="10" width="${box.width - 20}" height="${box.height - 20}" fill="none" stroke="#1a1a1a" stroke-width="2" filter="url(#wobble-p${pose})"/>`,
  };
}

// (a) INTRINSIC + (c) VIEWBOX + (d) CONTRACT + (e) BODY — one capture, four readings.
{
  env.reset();
  const pose = serializePoseSvg(gridPoseParts(0, { width: 200, height: 80 }));
  await rasterizePoseToBlob(pose, { width: 300, height: 120 }, 2);

  assert(env.blobs.length === 1, '(a) one capture => one blob document');
  const tag = rootTag(env.blobs[0]);
  assert(attr(tag, 'width') === '600', '(a) blob root width = round(cssSize.width × dpr) = 600');
  assert(attr(tag, 'height') === '240', '(a) blob root height = round(cssSize.height × dpr) = 240');
  assert(
    attr(tag, 'viewBox') === '0 0 200 80',
    '(c) the viewBox is untouched — user space preserved, only render resolution moves',
  );
  assert(
    attr(tag, 'width') === String(env.canvases[0].width) &&
      attr(tag, 'height') === String(env.canvases[0].height),
    '(d) the stamped intrinsic equals the canvas the capture draws into (600×240)',
  );
  assert(
    env.blobs[0].slice(tag.length) === pose.slice(rootTag(pose).length),
    '(e) everything after the root tag (inlined <defs> included) is byte-identical',
  );
  assert(attr(tag, 'xmlns') === 'http://www.w3.org/2000/svg', '(e) the svg namespace survives the stamp');
}

// (b) ROUNDING — a fractional box × dpr rounds, matching the canvas arithmetic exactly.
{
  env.reset();
  const pose = serializePoseSvg(gridPoseParts(1, { width: 200, height: 200 }));
  await rasterizePoseToBlob(pose, { width: 33.3, height: 17.7 }, 3);
  const tag = rootTag(env.blobs[0]);
  assert(attr(tag, 'width') === '100', '(b) round(33.3 × 3) = 100 stamped (no fractional intrinsic)');
  assert(attr(tag, 'height') === '53', '(b) round(17.7 × 3) = 53 stamped');
  assert(
    attr(tag, 'width') === String(env.canvases[0].width) &&
      attr(tag, 'height') === String(env.canvases[0].height),
    '(b) the stamp and the canvas agree on the rounded device box (100×53)',
  );
}

// (a′) DEFAULT DPR — the ratio defaults to the environment's; the stamp follows it.
{
  env.reset();
  const pose = serializePoseSvg(gridPoseParts(2, { width: 120, height: 60 }));
  await rasterizePoseToBlob(pose, { width: 120, height: 60 });
  const tag = rootTag(env.blobs[0]);
  assert(
    attr(tag, 'width') === '240' && attr(tag, 'height') === '120',
    '(a) the default dpr (2) stamps 240×120 for a 120×60 css box',
  );
}

// (f) GUARD — a viewBox-less root throws a named error and bakes nothing.
{
  env.reset();
  const noViewBox =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">` +
    `<rect x="0" y="0" width="200" height="80" fill="#1a1a1a"/>` +
    `</svg>`;
  let message = '';
  try {
    await rasterizePoseToBlob(noViewBox, { width: 300, height: 120 }, 2);
  } catch (e) {
    message = (e as Error).message;
  }
  assert(
    message.startsWith('rasterizePoseToBlob:'),
    '(f) a viewBox-less root throws a named rasterizePoseToBlob error',
  );
  assert(message.includes('viewBox'), '(f) the error names the missing viewBox');
  assert(env.blobs.length === 0, '(f) nothing was baked — the throw precedes blob creation');
}

// (g) ORDER — the self-contained guard fires first; a cascade leak is still ITS error.
{
  env.reset();
  const leak = serializePoseSvg({
    width: 10,
    height: 10,
    body: '<rect width="10" height="10" fill="currentColor"/>',
  });
  let message = '';
  try {
    await rasterizePoseToBlob(leak, { width: 10, height: 10 }, 2);
  } catch (e) {
    message = (e as Error).message;
  }
  assert(
    message.includes('not self-contained'),
    '(g) a currentColor leak rejects on the cascade guard, not the viewBox guard',
  );
  assert(env.blobs.length === 0, '(g) a leaked pose bakes nothing');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`raster-capture.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`raster-capture.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
