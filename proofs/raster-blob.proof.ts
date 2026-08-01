/**
 * raster-blob.proof — `rasterizePoseToBlob` hands the CAPTURE CANVAS'S OWN raster back
 * (0.11.0), and the structural claim behind the pixel identity.
 *
 *   node --import ./proofs/loader.mjs proofs/raster-blob.proof.ts
 *
 * WHY THIS IS A GATE: through 0.10.1 a consumer that wanted a durable render artifact took
 * `rasterizePose`'s `ImageBitmap`, drew it into a SECOND surface, and PNG-encoded that —
 * `createImageBitmap` 79–195 ms + `convertToBlob` 87–112 ms per pose, ≈98% of a measured
 * ~280 ms WebKit drawer-open stall (attribution: T5 design-loop pass 3). The bitmap was
 * never the artifact; it was a copy taken on the way to one. 0.11 encodes the capture canvas
 * directly, so the copy and its re-draw are gone.
 *
 * The identity claim is BY CONSTRUCTION: one internal `capturePoseCanvas` draws the pose,
 * and the encode reads THAT canvas — there is no second surface for a pixel to change on.
 * This lane proves the construction (one canvas, one encode, zero bitmap copies, the capture
 * invariants intact); the BYTE comparison against the retired round-trip is the browser
 * lane's, where pixels exist (`proofs/browser/blob-identity.spec.ts`).
 *
 * Proofs:
 *   (a) ONE SURFACE: one capture creates exactly ONE canvas and encodes THAT canvas's box —
 *       no intermediate surface exists to resample or re-encode through.
 *   (b) ZERO COPIES: `createImageBitmap` is never called on the blob path (the deleted copy,
 *       proven absent rather than argued).
 *   (c) CAPTURE INVARIANTS CARRY: the blob document still stamps the capture intrinsic in
 *       device px, still leaves the `viewBox` byte-identical, still leaves the body untouched
 *       (0.10.0's truth-fix is not lost by the new entry).
 *   (d) MIME: PNG by default; an explicit type is honoured and reaches the encoder.
 *   (e) GUARD ORDER: a cascade leak rejects before anything is captured; a viewBox-less root
 *       rejects on the intrinsic error — neither reaches the encoder.
 *   (f) ENCODER FAILURE IS EXPLICIT: a `null` from `toBlob` rejects with a named
 *       `rasterizePoseToBlob:` error, never a silent empty artifact.
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

// (a) ONE SURFACE + (b) ZERO COPIES + (c) INVARIANTS — one capture, read every way.
{
  env.reset();
  const pose = serializePoseSvg(gridPoseParts(0, { width: 200, height: 80 }));
  const blob = await rasterizePoseToBlob(pose, { width: 300, height: 120 }, 2);

  assert(env.canvases.length === 1, '(a) ONE canvas per capture — no intermediate surface');
  assert(env.encodes.length === 1, '(a) exactly one encode');
  assert(
    env.encodes[0].width === 600 && env.encodes[0].height === 240,
    '(a) the encode reads the CAPTURE canvas box (600x240 = round(cssSize x dpr))',
  );
  assert(
    env.canvases[0].width === env.encodes[0].width &&
      env.canvases[0].height === env.encodes[0].height,
    '(a) the encoded surface IS the surface the pose was drawn into',
  );
  assert(env.bitmapCopies === 0, '(b) ZERO createImageBitmap copies on the blob path');

  const tag = rootTag(env.blobs[0]);
  assert(attr(tag, 'width') === '600', '(c) capture intrinsic stamped: width = 600 device px');
  assert(attr(tag, 'height') === '240', '(c) capture intrinsic stamped: height = 240 device px');
  assert(
    attr(tag, 'viewBox') === '0 0 200 80',
    '(c) the viewBox is untouched — user space preserved, only render resolution moves',
  );
  assert(
    env.blobs[0].slice(env.blobs[0].indexOf('>') + 1) ===
      pose.slice(pose.indexOf('>') + 1),
    '(c) everything after the root tag is byte-identical to the serialized pose',
  );

  // (d) MIME
  assert(env.encodes[0].type === 'image/png', '(d) PNG by default');
  assert(
    (blob as unknown as { type: string }).type === 'image/png',
    '(d) the returned blob carries the encoded mime',
  );
}

// (d) an explicit type reaches the encoder.
{
  env.reset();
  const pose = serializePoseSvg(gridPoseParts(1, { width: 120, height: 120 }));
  await rasterizePoseToBlob(pose, { width: 120, height: 120 }, 1, 'image/webp');
  assert(env.encodes[0]?.type === 'image/webp', '(d) an explicit mime is honoured');
}

// (e) GUARD ORDER — the cascade leak rejects before any capture happens.
{
  env.reset();
  let message = '';
  try {
    await rasterizePoseToBlob(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="currentColor"/></svg>',
      { width: 10, height: 10 },
      2,
    );
  } catch (err) {
    message = (err as Error).message;
  }
  assert(
    message.includes('not self-contained'),
    '(e) a currentColor leak rejects on the cascade guard',
  );
  assert(
    env.blobs.length === 0 && env.canvases.length === 0 && env.encodes.length === 0,
    '(e) the leaking pose was never captured and never encoded',
  );
}

// (e) GUARD ORDER — a root with no viewBox rejects on the intrinsic error.
{
  env.reset();
  let message = '';
  try {
    await rasterizePoseToBlob(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="#000"/></svg>',
      { width: 10, height: 10 },
      2,
    );
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes('viewBox'), '(e) a viewBox-less root rejects on the intrinsic guard');
  assert(
    env.blobs.length === 0 && env.encodes.length === 0,
    '(e) the un-stampable pose was never captured and never encoded',
  );
}

// (f) ENCODER FAILURE IS EXPLICIT — a null from toBlob is a named rejection, not an empty
// artifact silently handed on.
{
  env.reset();
  env.failNextEncode = true;
  const pose = serializePoseSvg(gridPoseParts(2, { width: 64, height: 64 }));
  let message = '';
  try {
    await rasterizePoseToBlob(pose, { width: 64, height: 64 }, 2);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(
    message.startsWith('rasterizePoseToBlob:'),
    '(f) a null encode rejects with a NAMED error',
  );
  assert(env.encodes.length === 0, '(f) the failed encode produced no artifact');
}

console.log('');
if (failures.length > 0) {
  console.log(`raster-blob.proof: ${failures.length} FAILURE(S), ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`raster-blob.proof: ${passed} assertions passed`);
