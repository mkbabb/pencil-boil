/**
 * raster-serialize.proof — the Node-provable half of the 0.9.0 bitmap-pose-cache gate.
 *
 *   node --import ./proofs/loader.mjs proofs/raster-serialize.proof.ts
 *
 * `rasterizePoseStack`'s identity invariant (untainted capture, byte-deterministic pixel
 * hash, distinct-per-pose) is a BROWSER property — no canvas / ImageBitmap / SVG layout in
 * Node — so it lives in the separate Playwright `proof:browser` lane. The PURE half CAN be
 * proven here: the `poseSvg(i)` serializer and its self-contained guard. This closes the
 * FAM-1 vacuous-green class at the Node level — a dropped def (an un-substituted color) is
 * caught deterministically without a browser.
 *
 * Proofs:
 *   (a) INLINE: serializePoseSvg wraps the provided <defs> into the document (a detached
 *       blob can't reach the page <defs>); omits the wrapper when no defs are given.
 *   (b) FRAME: width/height/viewBox land on the root <svg>; viewBox defaults to the box.
 *   (c) DETERMINISM: a fixed PoseSvgParts serializes byte-identically across calls.
 *   (d) DISTINCT-PER-POSE: a per-pose builder yields a distinct string per pose (the boil
 *       motion survives — pose-for-pose).
 *   (e) GUARD: isSelfContainedSvg is true for resolved literals, false on a `currentColor`
 *       or `var(` leak — the dropped-def catch the browser identity lane reds at the pixel.
 */

import { serializePoseSvg, isSelfContainedSvg, type PoseSvgParts } from '../src/raster.ts';

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

// A realistic per-pose serializer: a frozen wobble filter def inlined, colors resolved to
// hex literals, parametrized by pose (a distinct turbulence seed/frequency per pose — the
// `wobblePoseFrequencies` shape). This is the compliant `poseSvg(i)` a consumer hands
// `rasterizePoseStack`; the proof exercises the discipline, not the app's exact strings.
const POSE_FREQ = [0.012, 0.018, 0.015, 0.021];
function gridPoseParts(pose: number): PoseSvgParts {
  const freq = POSE_FREQ[pose];
  return {
    width: 240,
    height: 240,
    defs:
      `<filter id="wobble-p${pose}">` +
      `<feTurbulence type="turbulence" baseFrequency="${freq}" numOctaves="2" seed="${pose}" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>` +
      `</filter>`,
    // colors resolved to hex literals — NOT currentColor / var(--grid-line-color).
    body: `<rect x="10" y="10" width="220" height="220" fill="none" stroke="#1a1a1a" stroke-width="2" filter="url(#wobble-p${pose})"/>`,
  };
}

// (a) INLINE — the defs are wrapped into the serialized document; absent defs → no wrapper.
{
  const withDefs = serializePoseSvg(gridPoseParts(0));
  assert(
    withDefs.includes('<defs><filter id="wobble-p0">') && withDefs.includes('</filter></defs>'),
    '(a) serializePoseSvg inlines the <defs> into the document',
  );
  const noDefs = serializePoseSvg({ width: 10, height: 10, body: '<rect width="10" height="10"/>' });
  assert(!noDefs.includes('<defs>'), '(a) no defs given => no <defs> wrapper emitted');
}

// (b) FRAME — root svg attrs; viewBox defaults to `0 0 w h`, an explicit one is honored.
{
  const s = serializePoseSvg(gridPoseParts(0));
  assert(
    s.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">'),
    '(b) root <svg> carries width/height and a defaulted viewBox',
  );
  assert(s.trimEnd().endsWith('</svg>'), '(b) the document closes with </svg>');
  const vb = serializePoseSvg({ width: 100, height: 50, viewBox: '0 0 200 100', body: '<g/>' });
  assert(vb.includes('viewBox="0 0 200 100"'), '(b) an explicit viewBox overrides the default');
}

// (c) DETERMINISM — a fixed PoseSvgParts serializes byte-identically across calls (pairs
// with useBoilCache: one cache key, one stable string).
{
  const a = serializePoseSvg(gridPoseParts(2));
  const b = serializePoseSvg(gridPoseParts(2));
  assert(a === b, '(c) a fixed pose serializes byte-identically (deterministic)');
}

// (d) DISTINCT-PER-POSE — each pose's frozen frequency/seed yields a distinct string, so
// the four-pose boil motion is preserved pose-for-pose.
{
  const strings = [0, 1, 2, 3].map((p) => serializePoseSvg(gridPoseParts(p)));
  const distinct = new Set(strings);
  assert(distinct.size === 4, '(d) four poses serialize to four distinct strings');
}

// (e) GUARD — the self-contained check: resolved literals pass; a currentColor / var() leak
// fails. This is the dropped-def catch the browser identity lane reds at the pixel, proven
// here on the serialized string without a browser.
{
  const clean = serializePoseSvg(gridPoseParts(1));
  assert(isSelfContainedSvg(clean), '(e) a resolved-literal pose SVG is self-contained');

  const leakColor = serializePoseSvg({
    width: 10,
    height: 10,
    body: '<rect width="10" height="10" fill="currentColor"/>', // un-resolved cascade color
  });
  assert(!isSelfContainedSvg(leakColor), '(e) a currentColor leak is NOT self-contained (dropped def)');

  const leakVar = serializePoseSvg({
    width: 10,
    height: 10,
    body: '<rect width="10" height="10" fill="var(--grid-line-color)"/>', // un-resolved var()
  });
  assert(!isSelfContainedSvg(leakVar), '(e) a var() leak is NOT self-contained (dropped def)');
}

const exit = (globalThis as { process?: { exit(code: number): never } }).process?.exit;
console.log('');
if (failures.length === 0) {
  console.log(`raster-serialize.proof: ${passed} assertions passed`);
  exit?.(0);
} else {
  console.log(`raster-serialize.proof: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  exit?.(1);
}
