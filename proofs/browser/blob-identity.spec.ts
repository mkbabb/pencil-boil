/**
 * proof:browser — PIXEL IDENTITY for 0.11's `rasterizePoseToBlob`.
 *
 * The 0.10.1 estate reached a durable render artifact by taking `rasterizePose`'s
 * `ImageBitmap`, re-drawing it into a second surface, and PNG-encoding that: measured
 * 79–195 ms `createImageBitmap` + 87–112 ms `convertToBlob` per pose, ≈98% of a ~280 ms
 * WebKit drawer-open stall. 0.11 encodes the capture canvas directly. The claim licensing
 * that deletion is that NO PIXEL MOVES — and a pixel claim is only provable where pixels
 * exist, so it is proved here, per engine, at DPR2, against the retired pipeline reproduced
 * in the fixture.
 *
 * Gate: decoded RGBA byte-for-byte equal (differingBytes 0, maxΔ 0) for every pose, in
 * chromium AND webkit. The per-arm wall times are printed for the record — a headless host's
 * numbers are not a device's, so they gate nothing.
 */
import { test, expect } from '@playwright/test';

const POSE_COUNT = 4;
const DEVICE_BOX = 480; // BOX(240) * DPR2

declare global {
  interface Window {
    __proof: {
      blobIdentity(pose: number): Promise<{
        boxMatch: boolean;
        w: number;
        h: number;
        refW?: number;
        refH?: number;
        differingBytes?: number;
        totalBytes?: number;
        maxDelta?: number;
        inkNew?: number;
        inkOld?: number;
        pngIdentical?: boolean;
        pngBytesNew?: number;
        pngBytesOld?: number;
        msNew?: number;
        msOld?: number;
      }>;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/fixture.html');
  await page.waitForFunction(() => Boolean(window.__proof));
});

test('rasterizePoseToBlob is pixel-identical to the retired bitmap round trip (DPR2)', async ({
  page,
}, testInfo) => {
  for (let pose = 0; pose < POSE_COUNT; pose++) {
    const r = await page.evaluate((p) => window.__proof.blobIdentity(p), pose);

    expect(r.boxMatch, `pose ${pose}: both arms decode to the same box`).toBe(true);
    expect(r.w, `pose ${pose} width`).toBe(DEVICE_BOX);
    expect(r.h, `pose ${pose} height`).toBe(DEVICE_BOX);
    expect(r.inkNew, `pose ${pose}: the blob path actually drew ink`).toBeGreaterThan(0);
    expect(r.totalBytes, `pose ${pose}: a full RGBA buffer was compared`).toBe(
      DEVICE_BOX * DEVICE_BOX * 4,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[${testInfo.project.name}] pose ${pose}: differing=${r.differingBytes}/${r.totalBytes} ` +
        `maxΔ=${r.maxDelta} pngIdentical=${r.pngIdentical} ` +
        `png=${r.pngBytesNew}B vs ${r.pngBytesOld}B ` +
        `blob=${r.msNew?.toFixed(1)}ms roundTrip=${r.msOld?.toFixed(1)}ms`,
    );

    expect(r.maxDelta, `pose ${pose}: no channel moved`).toBe(0);
    expect(r.differingBytes, `pose ${pose}: byte-for-byte identical raster`).toBe(0);
  }
});
