/**
 * proof:browser — the identity gate the Node harness cannot see (FAM-1, the 0.9.0 latent
 * vacuous green). Node stubs `window`/`rAF` but has no canvas, no `ImageBitmap`, no SVG
 * layout, so the capture's browser-only invariant ships un-asserted unless a real engine
 * runs it. This lane runs it in BOTH chromium and webkit at DPR2 and asserts:
 *
 *   (a) untainted      — a same-origin serialized-blob capture reads back (no CORS taint)
 *   (b) repeatMatch    — re-raster is byte-identical
 *   (c) distinct       — the four frozen poses hash distinctly
 *   (d) identity SSIM  — capture vs live compositor render >= 0.98, captured IN this engine
 *
 * (d) is a TOLERANCE FLOOR, not equality (crit-safari §6): WebKit's canvas-filter path and
 * its compositor-filter path diverge ~1px at displacement edges — an equality gate would
 * false-red every WebKit pose. There is NO cross-engine parity gate (feTurbulence differs by
 * engine, by design). The floor bites: flipping fixture.js's CAPTURE_PAPER to a wrong literal
 * (an unresolved color var baked to its fallback — self-contained, so Node's guard misses it)
 * shifts the whole box and drops SSIM below 0.98.
 */
import { test, expect } from '@playwright/test';

const SSIM_FLOOR = 0.98;
const POSE_COUNT = 4;
const DEVICE_BOX = 480; // BOX(240) * DPR2

declare global {
  interface Window {
    __proof: {
      poseCount: number;
      setLivePose(pose: number): void;
      taintAndHash(): Promise<{
        dpr: number;
        allClean: boolean;
        repeatMatch: boolean;
        distinctPoseHashes: number;
        poses: { tainted: boolean; nonBlank: number; w: number; h: number }[];
      }>;
      identity(
        pose: number,
        livePngB64: string,
      ): Promise<{ ssim: number; exactPct: number; maxDelta: number; w: number; h: number }>;
      allSelfContained(): boolean;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/fixture.html');
  await page.waitForFunction(() => Boolean(window.__proof));
});

test('untainted + repeatMatch + distinct-per-pose (DPR2)', async ({ page }) => {
  const r = await page.evaluate(() => window.__proof.taintAndHash());

  expect(r.dpr, 'device pixel ratio is 2').toBe(2);
  expect(r.allClean, '(a) untainted — getImageData never threw on a serialized-blob capture').toBe(
    true,
  );
  expect(r.repeatMatch, '(b) re-raster is byte-identical').toBe(true);
  expect(r.distinctPoseHashes, '(c) the four poses hash distinctly').toBe(POSE_COUNT);

  for (const [i, p] of r.poses.entries()) {
    expect(p.tainted, `pose ${i} untainted`).toBe(false);
    expect(p.w, `pose ${i} captured at device width`).toBe(DEVICE_BOX);
    expect(p.h, `pose ${i} captured at device height`).toBe(DEVICE_BOX);
    expect(p.nonBlank, `pose ${i} actually drew ink`).toBeGreaterThan(0);
  }
});

test('identity SSIM >= 0.98 capture-vs-live, per-engine (DPR2)', async ({ page }, testInfo) => {
  expect(
    await page.evaluate(() => window.__proof.allSelfContained()),
    'every capture SVG is self-contained — the identity result is the PIXEL gate, not the string guard',
  ).toBe(true);

  for (let pose = 0; pose < POSE_COUNT; pose++) {
    await page.evaluate((p) => window.__proof.setLivePose(p), pose);
    // let the compositor settle before the on-screen screenshot
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const png = await page.locator('#live-host svg').screenshot();
    const res = await page.evaluate(
      ({ p, b64 }) => window.__proof.identity(p, b64),
      { p: pose, b64: png.toString('base64') },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[${testInfo.project.name}] pose ${pose}: SSIM=${res.ssim.toFixed(4)} ` +
        `exact=${res.exactPct.toFixed(2)}% maxΔ=${res.maxDelta} (${res.w}x${res.h})`,
    );

    expect(res.w).toBe(DEVICE_BOX);
    expect(res.h).toBe(DEVICE_BOX);
    expect(
      res.ssim,
      `[${testInfo.project.name}] pose ${pose} identity SSIM >= ${SSIM_FLOOR}`,
    ).toBeGreaterThanOrEqual(SSIM_FLOOR);
  }
});
